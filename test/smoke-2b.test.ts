import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV, startServer, type RunningServer } from "../src/server/main.js";
import { startDemoUpstream } from "../src/server/demo-upstream.js";
import { SMOKE_SLACK_SKIP, parseSmokeArgs, runSmoke } from "../src/server/smoke.js";
import { mcpCall, mcpPost } from "../src/server/client.js";
import type { RunningFront } from "../src/front/contract.js";

// Slice 2b pin 6: the smoke client's new flags. --ca-file is proven against a throwaway node:https server with an
// openssl-made lab CA + leaf (no dependency on A's TLS front); --approvals slack and --expect-legacy against the real root.
const KEY = "smoke-2b-key-canary-6e1f"; const T = "smoke-2b-upstream-canary-0c9a";
const dirs: string[] = []; const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-ledger-smoke2b-")); dirs.push(d); return d; };
const write = (p: string, s: string | Buffer, mode = 0o600) => { writeFileSync(p, s, { mode }); chmodSync(p, mode); };
const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });

/** A lab CA and a leaf for 127.0.0.1 signed by it (what HOMELAB step 5b makes, shrunk to one day). */
function labCa(dir: string): { ca: string; cert: string; key: string } {
  const p = (n: string) => join(dir, n);
  openssl(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=agent-ledger test CA", "-keyout", p("ca.key"), "-out", p("ca.crt")]);
  openssl(["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", p("leaf.key"), "-out", p("leaf.csr")]);
  write(p("ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n", 0o644);
  openssl(["x509", "-req", "-in", p("leaf.csr"), "-CA", p("ca.crt"), "-CAkey", p("ca.key"), "-CAcreateserial", "-days", "1", "-extfile", p("ext.cnf"), "-out", p("leaf.crt")]);
  return { ca: p("ca.crt"), cert: p("leaf.crt"), key: p("leaf.key") };
}

describe("smoke 2b: parseSmokeArgs", () => {
  it("--approvals none|slack, --ca-file (PEM, https only), --expect-legacy <server name>", () => {
    const d = tmp(); const keyFile = join(d, "key"); write(keyFile, `${KEY}\n`);
    const pki = labCa(d);
    const url = "https://127.0.0.1:8443/mcp";
    expect(parseSmokeArgs(["--url", url, "--key-file", keyFile, "--approvals", "slack", "--ca-file", pki.ca, "--expect-legacy", "everything"]))
      .toEqual({ url, key: KEY, approvals: "slack", ca: readFileSync(pki.ca), expectLegacy: "everything" });
    expect(() => parseSmokeArgs(["--url", url, "--key-file", keyFile, "--approvals", "hook-ask"])).toThrow(/--approvals must be none or slack/);
    expect(() => parseSmokeArgs(["--url", url, "--key-file", keyFile, "--ca-file", keyFile])).toThrow(/not a PEM certificate/);
    expect(() => parseSmokeArgs(["--url", "http://127.0.0.1:1/mcp", "--key-file", keyFile, "--ca-file", pki.ca])).toThrow(/needs an https/);
    expect(() => parseSmokeArgs(["--url", url, "--key-file", keyFile, "--expect-legacy", "a b"])).toThrow(/--expect-legacy must be a server name/);
  });
});

describe("smoke 2b: client trusts exactly the given CA", () => {
  it("https with --ca-file → verified and answered; without it the global fetch fails verification; a wrong CA fails", async () => {
    const d = tmp(); const pki = labCa(d); mkdirSync(join(d, "other")); const other = labCa(join(d, "other"));
    const srv: HttpsServer = createHttpsServer({ cert: readFileSync(pki.cert), key: readFileSync(pki.key) }, (req, res) => {
      req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })); });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r(undefined)); }));
    const url = `https://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    expect(await mcpCall(url, KEY, "server/discover", {}, { ca: readFileSync(pki.ca) })).toEqual({ ok: true });
    await expect(mcpPost({ url, method: "server/discover" })).rejects.toThrow();
    await expect(mcpPost({ url, method: "server/discover", ca: readFileSync(other.ca) })).rejects.toThrow(/certificate|self.signed|verify/i);
    await expect(mcpPost({ url: url.replace("https:", "http:"), method: "x", ca: readFileSync(pki.ca) })).rejects.toThrow(/needs an https/);
  });
});

describe("smoke 2b: runSmoke against the real root", () => {
  it("--approvals slack reports the two human-gated steps as SKIP (never calls them); --expect-legacy adds `<server>__echo`", async () => {
    const demo: RunningFront = await startDemoUpstream({ port: 0, bindHost: "127.0.0.1", token: Buffer.from(T), log: () => undefined });
    closers.push(() => demo.stop());
    const dir = tmp();
    const sha = createHash("sha256").update(KEY).digest("hex");
    write(join(dir, "registry.yaml"), JSON.stringify({ version: 1, servers: { demo: { trusted: true, tools: {
      echo: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-10-04", storeArgs: ["message"] }, now: { class: "read", reviewedBy: "ryan", reviewedAt: "2026-10-04" },
      add: { class: "write", reviewedBy: "ryan", reviewedAt: "2026-10-04", storeArgs: ["a", "b"] } } } } }));
    write(join(dir, "agents.yaml"), JSON.stringify({ version: 1, agents: [{ id: "smoke", credential: { kind: "api_key", sha256: sha } }] }));
    write(join(dir, "hmac.key"), randomBytes(32));
    mkdirSync(join(dir, "secrets")); write(join(dir, "secrets", "demo.bearerToken"), T);
    write(join(dir, "upstreams.yaml"), `version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: http://127.0.0.1:${demo.port}/mcp\n`);
    const ledger = join(dir, "ledger", "r.jsonl");
    const server: RunningServer = await startServer({ [ENV.configDir]: dir, [ENV.ledgerUrl]: pathToFileURL(ledger).toString(), [ENV.port]: "0", [ENV.bindHost]: "127.0.0.1",
      [ENV.allowedOrigins]: "", [ENV.approvals]: "none", [ENV.tls]: "off", [ENV.connectBudget]: "0" }, { log: () => undefined });
    closers.push(() => server.stop());
    const lines: string[] = [];
    const code = await runSmoke({ url: `http://127.0.0.1:${server.port}/mcp`, key: KEY, approvals: "slack", expectLegacy: "demo" }, (l) => lines.push(l));
    expect(lines).toContain(`${SMOKE_SLACK_SKIP} demo__wipe denied: no channel`);
    expect(lines).toContain(`${SMOKE_SLACK_SKIP} demo__whoami denied: unreviewed`);
    expect(lines).toContain("ok demo__echo ok (legacy-era upstream through the proxy)");
    expect(lines.at(-1)).toBe("SMOKE PASS"); expect(code).toBe(0);
    expect(readFileSync(ledger, "utf8")).not.toMatch(/demo","tool":"(wipe|whoami)/);   // the skipped steps never reached the proxy
    expect(lines.join("\n")).not.toContain(KEY);
  });
});
