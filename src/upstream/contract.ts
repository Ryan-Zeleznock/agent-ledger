import type { ToolCall, ToolInfo, ToolResult } from "../types/index.js";
import type { SecretsProvider } from "../secrets/contract.js";
import { notImplemented } from "../types/not-implemented.js";
export interface UpstreamConfig { name: string; transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; }
export interface Upstream { listTools(): Promise<ToolInfo[]>; execute(call: ToolCall): Promise<ToolResult>; close(): Promise<void>; }
export function connectUpstreams(config: UpstreamConfig[], secrets: SecretsProvider): Promise<Upstream> { throw notImplemented("upstream.connectUpstreams"); }
