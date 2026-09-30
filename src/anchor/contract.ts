import { notImplemented } from "../types/not-implemented.js";
import { FileAnchor } from "./file.js";
export interface AnchorEntry { hash: string; at: string; }
export interface Anchor { write(entry: AnchorEntry): Promise<void>; latest(): Promise<AnchorEntry | null>; }
export function createAnchor(kind: "file" | "s3", target: string): Anchor {
  if (kind === "file") return new FileAnchor(target);
  throw notImplemented(`anchor.createAnchor(${kind})`); // later: S3 Object Lock (server mode)
}
