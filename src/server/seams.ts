// Slice 2b integration seams (docs/slices/slice-2b-pins.md pins 1, 2, 3). Package B (this root) is built in parallel with
// Package A (approvals, upstream, front) and codes against the PINNED names and shapes only. Each seam below is ONE shim,
// marked `// PIN-2B`, that resolves A's additive export at run time from the module namespace and fails closed when it
// is absent. At integration the coordinator replaces each shim with a direct named import; behaviour does not change.
import * as approvalsModule from "../approvals/contract.js";
import * as frontModule from "../front/contract.js";
import type { SlackChannel } from "../approvals/contract.js";
import type { SecretRef } from "../types/index.js";
import type { HttpFrontOptions } from "../front/contract.js";
import type { Upstream } from "../upstream/contract.js";

/** Thrown when an A export the root needs is not on this branch yet (pre-integration). The message names the export only. */
export class SeamMissing extends Error { override name = "SeamMissing"; }

// ---------- seam 1: approvals (pin 1) ----------
export interface SlackApprovalsConfig {
  apiBaseUrl?: string; fetch?: typeof fetch; WebSocket?: new (url: string) => unknown;
  now?: () => number; randomBytes?: (n: number) => Buffer; readSecret?: (ref: SecretRef) => Promise<string>;
}
export type ProbeSlackResult = { ok: true; teamId: string; botUserId: string; appId: string } | { ok: false; reason: string };
export interface SlackSeam {
  readonly SLACK_API_BASE_URL: string;
  readonly SLACK_PROXY_MAX_TIMEOUT_MS: number;
  configureSlackApprovals(cfg: SlackApprovalsConfig): void;
  probeSlack(channel: SlackChannel): Promise<ProbeSlackResult>;
  closeSlackApprovals(): Promise<void>;
}
// PIN-2B seam 1: replace with `import { SLACK_API_BASE_URL, SLACK_PROXY_MAX_TIMEOUT_MS, configureSlackApprovals, probeSlack, closeSlackApprovals } from "../approvals/contract.js"`.
const a = approvalsModule as unknown as Partial<SlackSeam>;
const needA = <K extends keyof SlackSeam>(k: K): NonNullable<SlackSeam[K]> => {
  const v = a[k];
  if (v === undefined) throw new SeamMissing(`approvals.${String(k)} is not on this branch yet (Slice 2b Package A; pre-integration)`);
  return v as NonNullable<SlackSeam[K]>;
};
export const slack: SlackSeam = {
  SLACK_API_BASE_URL: a.SLACK_API_BASE_URL ?? "https://slack.com/api/",      // the pinned literal (pin 1)
  SLACK_PROXY_MAX_TIMEOUT_MS: a.SLACK_PROXY_MAX_TIMEOUT_MS ?? 240_000,       // the pinned literal (pin 1, §0 B)
  configureSlackApprovals: (cfg) => needA("configureSlackApprovals")(cfg),
  // async wrappers: a missing export must surface as a REJECTED promise, so callers' `.catch` paths (shutdown, refusal
  // cleanup) still run; a synchronous throw would escape them (found by e2e row 0).
  probeSlack: async (ch) => needA("probeSlack")(ch),
  closeSlackApprovals: async () => needA("closeSlackApprovals")(),
};
/** Whether A's Slack implementation is present (the e2e self-skips its Slack steps until it is). */
export const slackSeamPresent = (): boolean => typeof a.configureSlackApprovals === "function" && typeof a.probeSlack === "function" && typeof a.closeSlackApprovals === "function";

// ---------- seam 2: front TLS (pin 3) ----------
export type TlsFrontOptions = HttpFrontOptions & { tls?: { cert: Buffer; key: Buffer } };
// PIN-2B seam 2: replace with passing `tls` straight to `startFront` (HttpFrontOptions.tls is additive in pin 3).
// Fail closed: a front without A's TLS support would silently ignore `tls` and serve plaintext, so the root refuses
// instead. `createFrontServer` ships in the same pin as `tls`, so its presence is the feature test.
export function frontSupportsTls(): boolean { return typeof (frontModule as Record<string, unknown>)["createFrontServer"] === "function"; }
export function withTls(opts: HttpFrontOptions, tls: { cert: Buffer; key: Buffer } | undefined): HttpFrontOptions {
  if (tls === undefined) return opts;
  if (!frontSupportsTls()) throw new SeamMissing("front TLS option is not on this branch yet (Slice 2b Package A pin 3; pre-integration)");
  return { ...opts, tls } as TlsFrontOptions;
}

// ---------- seam 3: upstream eras (pin 2) ----------
// PIN-2B seam 3: replace with `upstream.eras` (additive `Upstream.eras` in pin 2). Absent (pre-integration: modern-only
// client) → every connected server is modern by construction.
export function upstreamEras(upstream: Upstream, servers: readonly string[]): Record<string, "modern" | "legacy"> {
  const eras = (upstream as Upstream & { eras?: Readonly<Record<string, "modern" | "legacy">> }).eras;
  return Object.fromEntries(servers.map((s) => [s, eras?.[s] ?? "modern"]));
}
