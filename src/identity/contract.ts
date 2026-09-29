import type { AgentId, SessionId } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface AgentCredential { kind: "api_key" | "local"; value: string; }
export function resolveAgent(cred: AgentCredential): Promise<AgentId> { throw notImplemented("identity.resolveAgent"); }
export function startSession(agentId: AgentId, onBehalfOf?: string): Promise<SessionId> { throw notImplemented("identity.startSession"); }
