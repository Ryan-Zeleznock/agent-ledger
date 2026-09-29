import { notImplemented } from "../types/not-implemented.js";
export interface AnchorEntry { hash: string; at: string; }
export interface Anchor { write(entry: AnchorEntry): Promise<void>; latest(): Promise<AnchorEntry | null>; }
export function createAnchor(kind: "file" | "s3", target: string): Anchor { throw notImplemented("anchor.createAnchor"); }
