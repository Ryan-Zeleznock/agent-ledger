// Shared configuration I/O only; neither policy nor identity imports the other module.
import fs from "node:fs";
import { isScalar, parseDocument } from "yaml";

/** Check the same open file descriptor we read, avoiding a path stat/read replacement race. */
export function readConfigFile(path: string): string {
  const fd = fs.openSync(path, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (process.platform !== "win32" && ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid!())) {
      throw new Error("Unsafe configuration permissions");
    }
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function parseConfigDocument(source: string) {
  const doc = parseDocument(source, { uniqueKeys: true, schema: "core", merge: false, prettyErrors: false });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML configuration");
  const version = doc.get("version", true);
  // Validate spelling before toJS erases distinctions such as 0x1, +1, 1.0, and aliases.
  if (!isScalar(version) || version.value !== 1 || version.source !== "1" || version.type !== "PLAIN") {
    throw new Error("version: expected literal integer 1");
  }
  return doc;
}
