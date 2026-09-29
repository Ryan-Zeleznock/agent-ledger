import { notImplemented } from "../types/not-implemented.js";
export interface SecretsProvider { get(server: string): Promise<Record<string, string>>; }
export function createSecretsProvider(kind: "env" | "file", target?: string): SecretsProvider { throw notImplemented("secrets.createSecretsProvider"); }
