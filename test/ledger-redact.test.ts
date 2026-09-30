import { describe, it, expect } from "vitest";
import { redact } from "../src/ledger/contract.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn\n-----END RSA PRIVATE KEY-----";

const asJson = (v: unknown) => JSON.stringify(v);

describe("ledger.redact (spec §9: secrets and PII patterns, before hashing and storage)", () => {
  it("redacts values under secret-bearing field names, whatever their case or separator", () => {
    const out = redact({ password: "hunter2", API_KEY: "abc", refreshToken: "r1", "x-api-key": "k", AWS_SECRET_ACCESS_KEY: "s", Authorization: "Basic dXNlcjpwYXNz", passphrase: "p", clientSecret: "c", cookie: "a=b" });
    for (const v of Object.values(out)) expect(v).toMatch(/^\[REDACTED:key:/);
    expect(asJson(out)).not.toMatch(/hunter2|dXNlcjpwYXNz/);
  });

  it("keeps ordinary field names and values intact", () => {
    const args = { path: "/tmp/a.txt", count: 3, ok: true, none: null, sort_key: "name", author: "ryan", tokens: 42 };
    expect(redact(args)).toEqual(args);
  });

  it("redacts a whole non-string value under a secret key (an object of credentials becomes one placeholder)", () => {
    const out = redact({ credentials: { user: "u", pass: "p" }, tokens_list: ["a", "b"] });
    expect(out.credentials).toBe("[REDACTED:key:credentials]");
    expect(out.tokens_list).toEqual(["a", "b"]); // plural "tokens_list" is not a secret key
  });

  it("secrets nested in objects or arrays are redacted (todo: ledger)", () => {
    const out = redact({
      config: { db: { password: "pw", host: "h" } },
      headers: [{ name: "Authorization", value: `Bearer ${JWT}` }, { name: "Accept", value: "*/*" }],
      envs: [`AWS_ACCESS_KEY_ID=${AWS_KEY}`, ["deep", { secret: "s3cr3t" }]],
    });
    const json = asJson(out);
    expect(json).not.toMatch(/pw"|s3cr3t|AKIAIOSFODNN7EXAMPLE|SflKxwRJ/);
    expect((out.config as { db: { host: string } }).db.host).toBe("h");
    expect((out.headers as { value: string }[])[1]!.value).toBe("*/*");
  });

  it("redacts well-known token shapes inside free text, keeping the surrounding text", () => {
    const cmd = `curl -H "Authorization: Bearer ${JWT}" https://api.example.com && export AWS_ACCESS_KEY_ID=${AWS_KEY} AWS_SECRET_ACCESS_KEY=${AWS_SECRET} && echo ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123 sk-abcdefghijklmnopqrstuvwxyz012345 xoxb-1234567890-abcdefghijklmnop AIzaSyA-abcdefghijklmnopqrstuvwxyz01234`;
    const out = redact({ command: cmd }).command as string;
    expect(out).toContain("curl -H");
    expect(out).toContain("https://api.example.com");
    expect(out).not.toMatch(/SflKxwRJ|AKIAIOSFODNN7EXAMPLE|wJalrXUtnFEMI|ghp_ABCDEF|sk-abcdef|xoxb-1234|AIzaSyA-/);
    expect(out).toMatch(/\[REDACTED:bearer\]/);
    expect(out).toMatch(/\[REDACTED:aws-access-key-id\]/);
    expect(out).toMatch(/AWS_SECRET_ACCESS_KEY=\[REDACTED:assignment\]/);
  });

  it("redacts PEM private key blocks and credentials embedded in URLs", () => {
    const out = redact({ key: PEM, url: "postgres://admin:S3cret!@db.internal:5432/app", note: `see ${PEM} end` });
    expect(out.key).toBe("[REDACTED:key:key]"); // `key` alone is a secret-bearing field name
    expect(out.url).toBe("postgres://[REDACTED:url-credentials]@db.internal:5432/app");
    expect(out.note).toBe("see [REDACTED:private-key] end");
  });

  it("redacts PII: emails, US SSNs and Luhn-valid card numbers, but not arbitrary digit runs", () => {
    const out = redact({ to: "ryan@example.com", taxpayer: "123-45-6789", card: "4111 1111 1111 1111", id: "1234567890123456", sha: "3f2a9c" });
    expect(out.to).toBe("[REDACTED:email]");
    expect(out.taxpayer).toBe("[REDACTED:ssn]");
    expect(out.card).toBe("[REDACTED:card-number]");
    expect(out.id).toBe("1234567890123456"); // fails Luhn: kept
    expect(out.sha).toBe("3f2a9c");
  });

  it("is idempotent and does not mutate its input", () => {
    const args = { password: "pw", nested: [{ token: "t" }] };
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
});
