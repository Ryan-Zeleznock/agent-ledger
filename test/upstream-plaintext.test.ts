// ADR-018 §6 (server audit P2-4): an upstream bearer is never sent over plaintext http:// unless the host is loopback or
// the upstream entry sets `insecure: true`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectUpstreams, isLoopbackHost } from "../src/upstream/contract.js";
import { readUpstreamsConfig } from "../src/server/files.js";
import type { SecretsProvider } from "../src/secrets/contract.js";

const withBearer: SecretsProvider = { async get() { return { bearerToken: "upstream-token-5d1e" }; } };
const none: SecretsProvider = { async get() { return {}; } };
afterEach(() => { vi.unstubAllGlobals(); });
/** A fetch that records each call and fails it, so connect stops right after the plaintext check would have let it through. */
function recordingFetch() {
  const seen: { url: string; auth: string | undefined }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { seen.push({ url: String(url), auth: (init.headers as Record<string, string>)["authorization"] }); throw new TypeError("network down (test)"); }));
  return seen;
}

describe("ADR-018 §6: no plaintext bearer to a remote host", () => {
  it("isLoopbackHost: 127.0.0.0/8, ::1 and localhost only", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "[::1]", "::1"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["10.0.0.5", "128.0.0.1", "127.0.0.256", "localhost.evil.example", "demo-upstream.agent-ledger.svc.cluster.local", "0.0.0.0", "[::2]", "127.0.0.1.nip.io"]) expect(isLoopbackHost(h)).toBe(false);
  });
  it("refuses a bearer over http:// to a non-loopback host before any request is made; the token is not in the error", async () => {
    const seen = recordingFetch();
    const p = connectUpstreams([{ name: "demo", transport: "http", url: "http://demo-upstream.agent-ledger.svc.cluster.local:3001/mcp" }], withBearer);
    await expect(p).rejects.toThrow(/demo: refusing to send a bearer over plaintext http:\/\/ to a non-loopback host; use https:\/\/ or set insecure: true/);
    await p.catch((e: Error) => expect(e.message).not.toContain("upstream-token-5d1e"));
    expect(seen).toEqual([]);
  });
  it("insecure: true, https://, loopback http:// and no bearer all pass the check (the request is attempted)", async () => {
    for (const [cfg, secrets] of [
      [{ name: "demo", transport: "http", url: "http://10.0.0.5:3001/mcp", insecure: true }, withBearer],
      [{ name: "demo", transport: "http", url: "https://10.0.0.5:3001/mcp" }, withBearer],
      [{ name: "demo", transport: "http", url: "http://127.0.0.1:3001/mcp" }, withBearer],
      [{ name: "demo", transport: "http", url: "http://10.0.0.5:3001/mcp" }, none],
    ] as const) {
      const seen = recordingFetch();
      await expect(connectUpstreams([cfg], secrets)).rejects.not.toThrow(/plaintext/);
      expect(seen.length).toBeGreaterThan(0);
    }
  });
  it("insecure must be a boolean (connect) and true/false in upstreams.yaml; unknown keys stay refused", async () => {
    await expect(connectUpstreams([{ name: "demo", transport: "http", url: "http://10.0.0.5/mcp", insecure: "yes" as never }], withBearer)).rejects.toThrow(/insecure must be a boolean/);
    const dir = mkdtempSync(join(tmpdir(), "al-ups-"));
    const file = (body: string) => { const p = join(dir, `u${Math.random().toString(16).slice(2)}.yaml`); writeFileSync(p, body, { mode: 0o600 }); return p; };
    expect(readUpstreamsConfig(file("version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: http://x/mcp\n    insecure: true\n"))).toEqual([{ name: "demo", transport: "http", url: "http://x/mcp", insecure: true }]);
    expect(readUpstreamsConfig(file("version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: http://x/mcp\n"))).toEqual([{ name: "demo", transport: "http", url: "http://x/mcp" }]);
    expect(() => readUpstreamsConfig(file("version: 1\nupstreams:\n  - name: demo\n    transport: http\n    url: http://x/mcp\n    insecure: \"yes\"\n"))).toThrow(/insecure must be true or false/);
  });
});
