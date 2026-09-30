import { describe, it, expect } from "vitest";
import { redact } from "../src/ledger/contract.js";
import { ValidationError } from "../src/ledger/validate.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const GH = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----";

const asJson = (v: unknown) => JSON.stringify(v);
const gone = (out: unknown, ...secrets: string[]) => { const j = asJson(out); for (const s of secrets) expect(j, `leaked: ${s}`).not.toContain(s); };

describe("ledger.redact: key layer (spec §9)", () => {
  it("redacts values under secret-bearing field names, whatever their case, separator or width (NFKC)", () => {
    const out = redact({ password: "hunter2", API_KEY: "abc", refreshToken: "r1", "x-api-key": "k", AWS_SECRET_ACCESS_KEY: "s", Authorization: "Basic dXNlcjpwYXNz", passphrase: "p", clientSecret: "c", cookie: "a=b", "ｐａｓｓｗｏｒｄ": "fullwidth" });
    for (const v of Object.values(out)) expect(v).toMatch(/^\[REDACTED:key:[a-z]+\]$/);
    gone(out, "hunter2", "dXNlcjpwYXNz", "fullwidth");
  });
  it("keeps ordinary field names and values intact", () => {
    const args = { path: "/tmp/a.txt", count: 3, ok: true, none: null, sort_key: "name", author: "ryan", tokens: 42 };
    expect(redact(args)).toEqual(args);
  });
  it("redacts a whole non-string value under a secret key; the placeholder names OUR keyword, never the caller's key", () => {
    const out = redact({ credentials: { user: "u", pass: "p" }, tokens_list: ["a", "b"], [`${GH}_password`]: "x" });
    expect(out.credentials).toBe("[REDACTED:key:credentials]");
    expect(out.tokens_list).toEqual(["a", "b"]);
    gone(out, GH);
    expect(Object.keys(out)).toContain("[REDACTED:key#1]");
    expect(out["[REDACTED:key#1]"]).toBe("[REDACTED:key:password]");
  });
  it("Astra #3: a key that is itself a secret or PII is renamed collision-safely and never copied anywhere", () => {
    const out = redact({ [GH]: "present", "ryan@example.com": { role: "admin" }, "[REDACTED:key#1]": "taken" });
    gone(out, GH, "ryan@example.com");
    expect(Object.keys(out).sort()).toEqual(["[REDACTED:key#1]", "[REDACTED:key#2]", "[REDACTED:key#3]"].sort());
    expect(Object.values(out)).toContainEqual({ role: "admin" });
    expect(Object.values(out)).toContain("present");
  });
});

describe("ledger.redact: nested structures", () => {
  it("secrets nested in objects or arrays are redacted (todo: ledger)", () => {
    const out = redact({
      config: { db: { password: "pw", host: "h" } },
      headers: [{ name: "Authorization", value: `Bearer ${JWT}` }, { name: "Accept", value: "*/*" }],
      envs: [`AWS_ACCESS_KEY_ID=${AWS_KEY}`, ["deep", { secret: "s3cr3t" }]],
    });
    gone(out, '"pw"', "s3cr3t", AWS_KEY, "SflKxwRJ");
    expect((out.config as { db: { host: string } }).db.host).toBe("h");
    expect((out.headers as { value: string }[])[1]!.value).toBe("*/*");
  });
  it("Astra #4: argv pairs, header triples and name/value header objects", () => {
    const out = redact({
      argv: ["curl", "--password", "hunter2", "-u", "user", "--token=abc", "--verbose"],
      header: ["Authorization", "Bearer", "opaqueCredential"],
      header2: ["X-Api-Key", "k123"],
      obj: { name: "Authorization", value: "opaqueCredential2" },
      obj2: { header: "Cookie", value: "sid=abc" },
      benign: { name: "Accept", value: "text/html" },
    });
    gone(out, "hunter2", "opaqueCredential", "k123", "sid=abc", "--token=abc");
    expect((out.argv as string[])[0]).toBe("curl");
    expect((out.argv as string[])[6]).toBe("--verbose");
    expect(out.header).toEqual(["Authorization", "Bearer", "[REDACTED:pair]"]);
    expect((out.benign as { value: string }).value).toBe("text/html");
  });
});

describe("ledger.redact: free text (Astra #2)", () => {
  it("redacts quoted, multi-word, comma-separated and escaped assignment values", () => {
    const out = redact({
      a: 'password="two word secret" next=1',
      b: "password='alpha,beta' next",
      c: 'password="with \\"escaped\\" quote" tail',
      d: "DB_PASSWORD=hunter2 && echo ok",
      e: "password = hunter2",
      f: "password: hunter2\nuser: ryan",
      g: 'password="unterminated secret',
    });
    gone(out, "two word secret", "alpha,beta", "escaped", "hunter2", "unterminated secret");
    expect(out.a).toBe('password="[REDACTED:assignment]" next=1');
    expect(out.d).toBe("DB_PASSWORD=[REDACTED:assignment] && echo ok");
    expect(out.f).toBe("password: [REDACTED:assignment]\nuser: ryan");
  });
  it("redacts JSON carried inside a string structurally", () => {
    const out = redact({ body: JSON.stringify({ password: "two word secret", user: "u", nested: { token: "t" } }), arr: JSON.stringify([{ apiKey: "k" }]) });
    gone(out, "two word secret", '"t"', '"k"');
    expect(JSON.parse(out.body as string)).toEqual({ password: "[REDACTED:key:password]", user: "u", nested: { token: "[REDACTED:key:token]" } });
  });
  it("matches authentication schemes case-insensitively and requires placeholders to be complete", () => {
    const out = redact({
      a: "authorization: bearer opaqueCredential",
      b: "Authorization: BASIC dXNlcjpwYXNz",
      c: "password=[REDACTED:fake]hunter2",
      d: 'password="[REDACTED:fake]hunter2"',
      e: "token=[REDACTED:assignment]",
    });
    gone(out, "opaqueCredential", "dXNlcjpwYXNz", "hunter2");
    expect(out.e).toBe("token=[REDACTED:assignment]");
  });
  it("redacts well-known token shapes inside free text, keeping the surrounding text", () => {
    const cmd = `curl -H "Authorization: Bearer ${JWT}" https://api.example.com && echo ${AWS_KEY} && export AWS_SECRET_ACCESS_KEY=${AWS_SECRET} && echo ${GH} sk-abcdefghijklmnopqrstuvwxyz012345 xoxb-1234567890-abcdefghijklmnop AIzaSyA-abcdefghijklmnopqrstuvwxyz01234 ${JWT}`;
    const out = redact({ command: cmd }).command as string;
    expect(out).toContain("curl -H");
    expect(out).toContain("https://api.example.com");
    gone(out, "SflKxwRJ", AWS_KEY, "wJalrXUtnFEMI", "ghp_ABCDEF", "sk-abcdef", "xoxb-1234", "AIzaSyA-");
    expect(out).toMatch(/\[REDACTED:bearer\]/);
    expect(out).toMatch(/\[REDACTED:aws-access-key-id\]/);
    expect(out).toMatch(/\[REDACTED:jwt\]/);
    expect(out).toMatch(/AWS_SECRET_ACCESS_KEY=\[REDACTED:assignment\]/);
  });
  it("redacts PEM private key blocks, URL credentials and secret query parameters", () => {
    const out = redact({ key: PEM, url: "postgres://admin:S3cret!@db.internal:5432/app", note: `see ${PEM} end`, q: "https://h.example/cb?access_token=abc&state=xyz" });
    expect(out.key).toBe("[REDACTED:key:key]");
    expect(out.url).toBe("postgres://[REDACTED:url-credentials]@db.internal:5432/app");
    expect(out.note).toBe("see [REDACTED:private-key] end");
    expect(out.q).toBe("https://h.example/cb?access_token=[REDACTED:assignment]&state=xyz");
  });
  it("Astra #4: percent-, base64- and hex-encoded assignments are redacted as a whole when the decoded text carries a secret", () => {
    const b64 = Buffer.from("password=hunter2").toString("base64");
    const hex = Buffer.from("password=hunter2").toString("hex");
    const out = redact({ a: "cmd password%3Dhunter2 end", b: `payload ${b64} end`, c: `payload ${hex} end`, benign: "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=" });
    gone(out, "password%3Dhunter2", b64, hex);
    expect(out.a).toBe("cmd [REDACTED:encoded] end");
    expect(out.benign).toBe("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=");
  });
  it("redacts PII: emails, US SSNs and Luhn-valid card numbers, but not arbitrary digit runs", () => {
    const out = redact({ to: "ryan@example.com", taxpayer: "123-45-6789", card: "4111 1111 1111 1111", id: "1234567890123456", sha: "3f2a9c", text: "mail ryan.z@sub.example.co.uk, ok" });
    expect(out.to).toBe("[REDACTED:email]");
    expect(out.taxpayer).toBe("[REDACTED:ssn]");
    expect(out.card).toBe("[REDACTED:card-number]");
    expect(out.id).toBe("1234567890123456");
    expect(out.sha).toBe("3f2a9c");
    expect(out.text).toBe("mail [REDACTED:email], ok");
  });
});

describe("ledger.redact: re-review cases (Astra 2026-09-30, round 2)", () => {
  it("P1: a scheme inside an assignment value, with or without a space, loses its credential", () => {
    const out = redact({ a: "authorization:bearer opaqueCredential", b: "Authorization:Basic dXNlcjpwYXNz", c: "x-auth-token: Bearer tok123 tail" });
    gone(out, "opaqueCredential", "dXNlcjpwYXNz", "tok123");
    expect(out.a).toBe("authorization:bearer [REDACTED:bearer]");
    expect(out.c).toBe("x-auth-token: Bearer [REDACTED:bearer] tail");
  });
  it("P1: words over 1 KiB are replaced whole, wherever they are (value, key, URL userinfo), never left unscanned", () => {
    const long = "x".repeat(1024) + "/ghp_" + "A".repeat(36);
    const longUrl = "https://" + "u".repeat(600) + ":" + "p".repeat(600) + "@host.example/path";
    const out = redact({ v: `see ${long} end`, [long]: "present", url: longUrl, ok: "y".repeat(1024) });
    gone(out, "ghp_", "p".repeat(600), long);
    expect(out.v).toBe("see [REDACTED:long-word] end");
    expect(out.url).toBe("[REDACTED:long-word]");
    expect(out.ok).toBe("y".repeat(1024)); // exactly WORD_MAX is still scanned normally
    expect(Object.keys(out)).toContain("[REDACTED:key#1]");
  });
  it("P2: short base64/hex assignments are decoded (one level only: double-encoding is a documented residual)", () => {
    const out = redact({ b64: "dG9rZW49eA==", hex: "746f6b656e3d78", b64url: Buffer.from("password=hunter2").toString("base64url"), once: "password%3Dhunter2", twice: "password%253Dhunter2", plain: "deadbeef", sha: "3f2a9c1b4d5e6f708192a3b4c5d6e7f8" });
    gone(out, "dG9rZW49eA==", "746f6b656e3d78", "password%3Dhunter2");
    expect(out.b64).toBe("[REDACTED:encoded]");
    expect(out.b64url).toBe("[REDACTED:encoded]");
    expect(out.twice).toBe("password%253Dhunter2"); // exactly one decode level
    expect(out.plain).toBe("deadbeef");
    expect(out.sha).toBe("3f2a9c1b4d5e6f708192a3b4c5d6e7f8");
  });
  it("P2: absurdly nested JSON or quotes inside a string neither throws nor bypasses the depth budget", () => {
    const deep = "[".repeat(10_000) + "]".repeat(10_000);
    expect(() => redact({ deep })).not.toThrow();
    const deepSecret = "[".repeat(100) + JSON.stringify({ password: "hunter2" }) + "]".repeat(100);
    gone(redact({ deepSecret }), "hunter2"); // over budget → tokeniser fallback still catches the assignment
    const alt = "\"'".repeat(50_000) + " password=hunter2";
    gone(redact({ alt }), "hunter2");
    const inBudget = JSON.stringify({ a: [{ b: { password: "hunter2" } }] });
    expect(JSON.parse(redact({ inBudget }).inBudget as string)).toEqual({ a: [{ b: { password: "[REDACTED:key:password]" } }] });
  });
  it("P1: renaming many leaking keys is linear (Set-based) and PEM heads never rescan", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) big[`u${i}@example.com`] = 0;
    const t0 = performance.now(); const out = redact(big); const ms = performance.now() - t0;
    expect(Object.keys(out).length).toBe(20_000);
    expect(Object.keys(out).every((k) => /^\[REDACTED:key#\d+\]$/.test(k))).toBe(true);
    expect(ms).toBeLessThan(1500);
    const heads = "-----BEGIN ".repeat(20_000);
    const t1 = performance.now(); redact({ heads }); expect(performance.now() - t1).toBeLessThan(300);
    const keys = `${"-----BEGIN RSA PRIVATE KEY-----\nAAAA\n".repeat(3000)}-----END RSA PRIVATE KEY-----`;
    gone(redact({ keys }), "AAAA");
  });
  it("still handles the round-1 forms after the tokeniser change: quoted names, escapes, unterminated values, apostrophes in prose", () => {
    const out = redact({
      a: '{"password":"two words","user":"u"} trailing text token=abc',
      b: "it's fine, don't panic; the Bearer abc123 must go",
      c: 'password="a \\"b\\" c" x',
      d: "password='unterminated",
      e: "note: nothing secret here",
    });
    gone(out, "two words", "abc123", '"b\\"', "unterminated");
    expect(out.b).toBe("it's fine, don't panic; the Bearer [REDACTED:bearer] must go");
    expect(out.e).toBe("note: nothing secret here");
  });
});

describe("ledger.redact: invariants", () => {
  it("is idempotent and does not mutate its input", () => {
    const args = { password: "pw", nested: [{ token: "t" }], text: 'x password="a b" Bearer zz ryan@example.com --secret s', argv: ["--password", "p"], j: JSON.stringify({ token: "t" }) };
    const copy = structuredClone(args);
    const once = redact(args);
    expect(args).toEqual(copy);
    expect(redact(once)).toEqual(once);
  });
  it("does not treat inherited or prototype-polluting keys as data", () => {
    const args = JSON.parse('{"__proto__": {"polluted": true}, "password": "x"}') as Record<string, unknown>;
    const out = redact(args);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(out.password).toBe("[REDACTED:key:password]");
  });
  it("Astra #5: enforces the JSON-only boundary: toJSON, accessors, functions and class instances are rejected", () => {
    expect(() => redact({ obj: { toJSON() { return { password: "raw-from-toJSON" }; } } })).toThrow(ValidationError);
    expect(() => redact(Object.defineProperty({}, "x", { get: () => "s", enumerable: true }))).toThrow(ValidationError);
    expect(() => redact({ d: new Date() })).toThrow(ValidationError);
    expect(() => redact({ u: undefined })).toThrow(ValidationError);
  });
  it("Astra #6: benign and adversarial long strings redact in time that grows linearly (in-process smoke; hard-deadline test lives in the child-process suite)", () => {
    const time = (s: string) => { const t = performance.now(); redact({ s }); return performance.now() - t; };
    const benign = (n: number) => "x".repeat(n);
    const words = (n: number) => "alpha beta gamma@ ".repeat(n / 18);
    const t20 = time(benign(20_000)); const t80 = time(benign(80_000)); const t160 = time(benign(160_000));
    expect(t160).toBeLessThan(250);
    expect(t80 + t160).toBeLessThan(Math.max(20, t20) * 40);
    expect(time(words(160_000))).toBeLessThan(400);
  });
});
