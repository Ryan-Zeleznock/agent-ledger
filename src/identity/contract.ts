import type { AgentCredential, AgentId, SessionId } from "../types/index.js";
import { notImplemented } from "../types/not-implemented.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
export interface IdentityService {
  /** Maps a credential to a known agent. Rejects (throws) when the agent is unknown. */
  resolveAgent(cred: AgentCredential): Promise<AgentId>;
  startSession(agentId: AgentId, onBehalfOf?: string): Promise<SessionId>;
}
/** Backends: a static agent registry file (local mode) or Postgres (server mode). */
export function createIdentity(kind: "file" | "postgres", target: string): IdentityService {
  if (kind === "postgres") throw notImplemented("identity.createIdentity.postgres");
  if (kind !== "file") throw new Error("Unknown identity backend");
  const { agents, credentials } = loadAgents(target);
  // Session metadata is process-local. No credential value is retained or written.
  const sessions = new Map<SessionId, { agentId: AgentId; onBehalfOf?: string }>();
  return {
    async resolveAgent(cred) {
      if (!cred || !Object.hasOwn(cred, "kind") || !Object.hasOwn(cred, "value") ||
          (cred.kind !== "local" && cred.kind !== "api_key") || typeof cred.value !== "string" || !cred.value.length) {
        throw new Error("Unknown agent credential");
      }
      const digest = createHash("sha256").update(cred.value, "utf8").digest("hex");
      const agentId = credentials.get(`${cred.kind}:${digest}`);
      if (agentId === undefined) throw new Error("Unknown agent credential");
      return agentId;
    },
    async startSession(agentId, onBehalfOf) {
      if (!agents.has(agentId)) throw new Error("Unknown agent");
      if (onBehalfOf !== undefined && (typeof onBehalfOf !== "string" || !onBehalfOf.trim())) {
        throw new Error("Invalid onBehalfOf");
      }
      let id: SessionId;
      do { id = randomUUID(); } while (sessions.has(id));
      sessions.set(id, { agentId, ...(onBehalfOf === undefined ? {} : { onBehalfOf }) });
      return id;
    },
  };
}

function loadAgents(target: string): { agents: Set<AgentId>; credentials: Map<string, AgentId> } {
  let source: string;
  try { source = readFileSync(target, "utf8"); }
  catch { throw new Error("Unable to read identity registry"); }
  try {
    const doc = parseDocument(source, { uniqueKeys: true, schema: "core", merge: false, prettyErrors: false });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    const root = fields(doc.toJS({ mapAsMap: true }), ["version", "agents"]);
    if (root.get("version") !== 1 || !Array.isArray(root.get("agents"))) throw new Error();
    const agents = new Set<AgentId>();
    const credentials = new Map<string, AgentId>();
    for (const value of root.get("agents") as unknown[]) {
      const row = fields(value, ["id", "credential"]);
      const id = row.get("id");
      if (typeof id !== "string" || !id.trim() || agents.has(id)) throw new Error();
      const cred = fields(row.get("credential"), ["kind", "sha256"]);
      const kind = cred.get("kind"), hash = cred.get("sha256");
      if ((kind !== "local" && kind !== "api_key") || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error();
      const key = `${kind}:${hash}`;
      if (credentials.has(key)) throw new Error();
      agents.add(id);
      credentials.set(key, id);
    }
    return { agents, credentials };
  } catch {
    // YAML diagnostics may contain source snippets, including accidentally pasted credentials.
    throw new Error("Invalid identity registry");
  }
}

function fields(value: unknown, allowed: readonly string[]): Map<string, unknown> {
  if (!(value instanceof Map) || [...value.keys()].some(key => typeof key !== "string" || !allowed.includes(key))) throw new Error();
  return value;
}
