import type { AgentCredential, AgentId, SessionId } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
export interface IdentityService {
  /** Maps a credential to a known agent. Rejects (throws) when the agent is unknown. */
  resolveAgent(cred: AgentCredential): Promise<AgentId>;
  startSession(agentId: AgentId, onBehalfOf?: string): Promise<SessionId>;
}
/** Backends: a static agent registry file (local mode) or Postgres (server mode). */
export function createIdentity(kind: "file" | "postgres", target: string): IdentityService { throw notImplemented("identity.createIdentity"); }
