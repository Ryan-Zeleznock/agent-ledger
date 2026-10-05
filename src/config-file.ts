// Shared configuration I/O only; neither policy nor identity imports the other module.
import fs from "node:fs";
import { isAlias, isCollection, isPair, isScalar, parseDocument } from "yaml";

export const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CONFIG_NODES = 100_000;
const MAX_CONFIG_DEPTH = 64;

/** Check the same open file descriptor we read, avoiding a path stat/read replacement race. */
export function readConfigFile(path: string): string {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Configuration must be a regular file");
    if (stat.size > MAX_CONFIG_BYTES) throw new Error("Configuration size limit exceeded");
    if (process.platform !== "win32" && ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid!())) {
      throw new Error("Unsafe configuration permissions");
    }
    // A bounded read remains bounded if another writer grows the file after fstat.
    const buf = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let used = 0;
    while (used < buf.length) {
      const n = fs.readSync(fd, buf, used, buf.length - used, null);
      if (n === 0) break;
      used += n;
    }
    if (used > MAX_CONFIG_BYTES) throw new Error("Configuration size limit exceeded");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, used));
  } finally {
    fs.closeSync(fd);
  }
}

export function parseConfigDocument(source: string) {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) throw new Error("Configuration size limit exceeded");
  const doc = parseDocument(source, { uniqueKeys: true, schema: "core", merge: false, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML configuration");
  // Inspect the AST iteratively before callers invoke toJS; aliases can amplify or cycle.
  const pending: { node: unknown; depth: number }[] = [{ node: doc.contents, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > MAX_CONFIG_NODES || depth > MAX_CONFIG_DEPTH) throw new Error("Configuration structure limit exceeded");
    if (isAlias(node)) throw new Error("Configuration aliases are not supported");
    if (isPair(node)) pending.push({ node: node.key, depth: depth + 1 }, { node: node.value, depth: depth + 1 });
    else if (isCollection(node)) for (const item of node.items) pending.push({ node: item, depth: depth + 1 });
  }
  const version = doc.get("version", true);
  // Validate spelling before toJS erases distinctions such as 0x1, +1, 1.0, and aliases.
  if (!isScalar(version) || version.value !== 1 || version.source !== "1" || version.type !== "PLAIN") {
    throw new Error("version: expected literal integer 1");
  }
  return doc;
}
