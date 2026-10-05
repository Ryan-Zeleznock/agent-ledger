// Slice 2b integration seams (docs/slices/slice-2b-pins.md pins 1, 2, 3). Package B was built in parallel with Package A
// against pinned names; at integration the run-time `// PIN-2B` shims were replaced by direct imports. The names below are
// kept so the root and its tests address one module; behaviour is unchanged.
import {
  SLACK_API_BASE_URL, SLACK_PROXY_MAX_TIMEOUT_MS, configureSlackApprovals, probeSlack, closeSlackApprovals,
} from "../approvals/contract.js";
import type { HttpFrontOptions } from "../front/contract.js";
import type { Upstream } from "../upstream/contract.js";

/** Kept for callers that still name it; nothing on the integrated tree throws it. */
export class SeamMissing extends Error { override name = "SeamMissing"; }

// ---------- seam 1: approvals (pin 1) ----------
export const slack = { SLACK_API_BASE_URL, SLACK_PROXY_MAX_TIMEOUT_MS, configureSlackApprovals, probeSlack, closeSlackApprovals } as const;
export const slackSeamPresent = (): boolean => true;

// ---------- seam 2: front TLS (pin 3: HttpFrontOptions.tls) ----------
export function frontSupportsTls(): boolean { return true; }
export function withTls(opts: HttpFrontOptions, tls: { cert: Buffer; key: Buffer } | undefined): HttpFrontOptions {
  return tls === undefined ? opts : { ...opts, tls };
}

// ---------- seam 3: upstream eras (pin 2: Upstream.eras) ----------
export function upstreamEras(upstream: Upstream, servers: readonly string[]): Record<string, "modern" | "legacy"> {
  return Object.fromEntries(servers.map((s) => [s, upstream.eras?.[s] ?? "modern"]));
}
