import type { CallHandler, ToolInfo } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface FrontOptions { mode: "stdio" | "http"; port?: number; tools: () => Promise<ToolInfo[]>; }
export interface RunningFront { stop(): Promise<void>; }
export function startFront(handler: CallHandler, opts: FrontOptions): Promise<RunningFront> { throw notImplemented("front.startFront"); }
