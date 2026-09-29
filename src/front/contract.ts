import type { CallHandler, ToolInfo } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";

/** Verified against https://modelcontextprotocol.io/specification/2026-07-28/changelog on 2026-09-29 (spec §3). */
export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

interface FrontBase { tools: () => Promise<ToolInfo[]>; }
export interface StdioFrontOptions extends FrontBase { mode: "stdio"; }
/**
 * Streamable HTTP, revision 2026-07-28: stateless (no initialize handshake, no Mcp-Session-Id; every POST carries
 * MCP-Protocol-Version, Mcp-Method and, for tools/call, Mcp-Name). The front MUST validate Origin (403 on a
 * mismatch) and SHOULD bind to localhost when run locally; both come from these options.
 */
export interface HttpFrontOptions extends FrontBase {
  mode: "http";
  port?: number;
  /** Interface to listen on. Default "127.0.0.1"; server mode in a container sets "0.0.0.0" on purpose. */
  bindHost?: string;
  /** Exact Origin values accepted. A request whose Origin is present and not listed gets 403. Empty list = no browser origin allowed. */
  allowedOrigins: string[];
}
export type FrontOptions = StdioFrontOptions | HttpFrontOptions;
export const DEFAULT_BIND_HOST = "127.0.0.1";

export interface RunningFront { stop(): Promise<void>; }
/**
 * Our IncomingCall.callId is per call; the pipeline's sessionId is OURS (identity.startSession), not an MCP
 * session: MCP 2026-07-28 has no protocol-level sessions, so nothing here reads or mints Mcp-Session-Id.
 */
export function startFront(handler: CallHandler, opts: FrontOptions): Promise<RunningFront> { throw notImplemented("front.startFront"); }
