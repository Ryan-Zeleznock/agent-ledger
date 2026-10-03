import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_SECRET_FILE_BYTES, SECRET_FILE_NAME_RE, createSecretsProvider } from "../src/secrets/contract.js";

// Slice 2a pin 4: `createSecretsProvider("file", dir)`; `<server>.<key>` files; read once; symlinks refused; errors name the file, never a value.
const dirs: string[] = [];
const sandbox = () => { const d = mkdtempSync(join(tmpdir(), "agent-ledger-secrets-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const put = (dir: string, name: string, value: string, mode = 0o600) => { writeFileSync(join(dir, name), value, { mode }); chmodSync(join(dir, name), mode); }; // the umask masks writeFileSync's mode
const T1 = "tok-canary-6f2a1b"; const T2 = "other-canary-9c3d"; const T3 = "third-canary-0e4f";

describe("secrets: file provider", () => {
  it("get(server) returns only that server's keys, trimmed; {} for a server with none; the result is a fresh copy each time", async () => {
    const dir = sandbox();
    put(dir, "demo.bearerToken", `${T1}\n`); put(dir, "demo.other_key", `  ${T2}  \n`); put(dir, "github.token", T3);
    const p = createSecretsProvider("file", dir);
    expect(await p.get("demo")).toEqual({ bearerToken: T1, other_key: T2 });
    expect(await p.get("github")).toEqual({ token: T3 });
    expect(await p.get("nobody")).toEqual({});
    const a = await p.get("demo"); a["bearerToken"] = "mutated"; delete a["other_key"];
    expect(await p.get("demo")).toEqual({ bearerToken: T1, other_key: T2 });
    expect(Object.getPrototypeOf(await p.get("demo"))).toBe(Object.prototype);
  });
  it("the directory is read ONCE at construction: files added or changed later are not seen (refresh is 2b)", async () => {
    const dir = sandbox();
    put(dir, "demo.bearerToken", T1);
    const p = createSecretsProvider("file", dir);
    put(dir, "demo.bearerToken", "changed"); put(dir, "late.token", "late");
    expect(await p.get("demo")).toEqual({ bearerToken: T1 });
    expect(await p.get("late")).toEqual({});
  });
  it("values live in a closure: the provider object has no own property holding them and serialises to {}", async () => {
    const dir = sandbox();
    put(dir, "demo.bearerToken", T1);
    const p = createSecretsProvider("file", dir);
    expect(Object.keys(p)).toEqual(["get"]);
    expect(JSON.stringify(p)).toBe("{}");
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(p))).not.toContain(T1);
  });
  it("a symlink is refused (O_NOFOLLOW), naming the link, never the target's contents (a directly mounted K8s Secret volume is all symlinks: stage it first, pin 8)", () => {
    const dir = sandbox();
    put(dir, "real.value", T1);
    const target = join(sandbox(), "secret-target"); writeFileSync(target, T2, { mode: 0o600 });
    symlinkSync(target, join(dir, "demo.bearerToken"));
    let err: Error | undefined;
    try { createSecretsProvider("file", dir); } catch (e) { err = e as Error; }
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/"demo\.bearerToken" is a symlink; refused/);
    expect(err!.message).not.toContain(T1); expect(err!.message).not.toContain(T2); expect(err!.message).not.toContain(target);
  });
  it.each([
    ["demo", "no dot"], ["demo.bearer-token", "hyphen in key"], [".hidden", "dot file"], ["..data", "K8s volume marker"], ["demo..x", "empty middle"],
    ["de mo.key", "space"], ["demo.key.extra", "two dots"], ["dé.key", "non-ASCII"],
  ])("a file named %s (%s) is refused by name, before any contents are read into an error", (name) => {
    const dir = sandbox();
    put(dir, "fine.key", T1); put(dir, name, T2);
    let err: Error | undefined;
    try { createSecretsProvider("file", dir); } catch (e) { err = e as Error; }
    expect(err!.message).toContain(JSON.stringify(name)); expect(err!.message).toMatch(/not a <server>\.<key> file name/);
    expect(err!.message).not.toContain(T2); expect(err!.message).not.toContain(T1);
    expect(SECRET_FILE_NAME_RE.test(name)).toBe(false);
  });
  it("a subdirectory, a group/world-writable file and an oversized file are refused by name; values never appear in the error", () => {
    const d1 = sandbox(); mkdirSync(join(d1, "demo.sub"));
    expect(() => createSecretsProvider("file", d1)).toThrow(/"demo\.sub" (is not a regular file|cannot be opened)/);
    const d2 = sandbox(); put(d2, "demo.bearerToken", T1, 0o666); // 0644 is NOT refused: the rule is "not group/world-writable", as readConfigFile has it
    let err: Error | undefined;
    try { createSecretsProvider("file", d2); } catch (e) { err = e as Error; }
    expect(err!.message).toMatch(/"demo\.bearerToken" has unsafe permissions or owner/); expect(err!.message).not.toContain(T1);
    const d3 = sandbox(); put(d3, "demo.big", `${T1}${"x".repeat(MAX_SECRET_FILE_BYTES)}`);
    try { createSecretsProvider("file", d3); } catch (e) { err = e as Error; }
    expect(err!.message).toMatch(/"demo\.big" exceeds \d+ bytes/); expect(err!.message).not.toContain(T1);
    chmodSync(join(d2, "demo.bearerToken"), 0o600);
    expect(() => createSecretsProvider("file", d2)).not.toThrow();
  });
  it("mode 0600 and 0400 files are accepted (the staging initContainer writes 0600)", async () => {
    const dir = sandbox(); put(dir, "a.k", "1", 0o600); put(dir, "b.k", "2", 0o400);
    const p = createSecretsProvider("file", dir);
    expect([await p.get("a"), await p.get("b")]).toEqual([{ k: "1" }, { k: "2" }]);
  });
  it("target must be an existing directory; env is not implemented (2b); an unknown kind throws; get() needs a string", async () => {
    expect(() => createSecretsProvider("file", join(sandbox(), "missing"))).toThrow(/directory not readable/);
    const f = join(sandbox(), "a-file"); writeFileSync(f, "");
    expect(() => createSecretsProvider("file", f)).toThrow(/not a directory/);
    expect(() => createSecretsProvider("file")).toThrow(/needs a directory path/);
    expect(() => createSecretsProvider("file", "")).toThrow(/needs a directory path/);
    expect(() => createSecretsProvider("env", "X")).toThrow(/^not implemented: secrets\.createSecretsProvider\(env\)/);
    expect(() => createSecretsProvider("vault" as "file", sandbox())).toThrow(/unknown provider kind/);
    const p = createSecretsProvider("file", sandbox());
    await expect(p.get(1 as unknown as string)).rejects.toThrow(/server name must be a string/);
    expect(await p.get("__proto__")).toEqual({});
    expect(await p.get("constructor")).toEqual({});
  });
  it("prototype-named servers and keys are plain data: `constructor.toString` is a file like any other and lookups are own-property", async () => {
    const dir = sandbox(); put(dir, "constructor.toString", T1); put(dir, "demo.__proto__", T2);
    const p = createSecretsProvider("file", dir);
    expect(await p.get("constructor")).toEqual({ toString: T1 });
    const demo = await p.get("demo");
    expect(Object.hasOwn(demo, "__proto__")).toBe(true); expect(Object.getPrototypeOf(demo)).toBe(Object.prototype);
    expect(await p.get("toString")).toEqual({});
  });
});

describe("secrets F8: a FIFO in the secrets directory is refused, not blocked on (Astra review)", () => {
  it("a correctly named FIFO with no writer: construction fails fast in a child process with a timeout, naming the file", () => {
    const dir = sandbox();
    put(dir, "fine.key", T1);
    execFileSync("mkfifo", ["-m", "600", join(dir, "demo.bearerToken")]);
    const script = `import(${JSON.stringify(pathToFileURL(resolve(".test-build/src/secrets/contract.js")).href)}).then((m) => { try { m.createSecretsProvider("file", ${JSON.stringify(dir)}); console.log("NO THROW"); } catch (e) { console.log(e.message); } })`;
    const out = execFileSync(process.execPath, ["-e", script], { timeout: 5_000, encoding: "utf8" });
    expect(out.trim()).toBe('secrets: "demo.bearerToken" is not a regular file');
    expect(out).not.toContain(T1);
  });
});
