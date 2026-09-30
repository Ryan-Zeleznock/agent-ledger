import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";

/** Keep YAML mappings as Maps until validated; never coerce non-string keys. */
export async function readYaml(path: string): Promise<unknown> {
  const doc = parseDocument(await readFile(path, "utf8"), {
    uniqueKeys: true, schema: "core", merge: false, prettyErrors: false,
  });
  if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML configuration");
  return doc.toJS({ mapAsMap: true });
}
export function mapping(value: unknown, at: string, fields?: readonly string[]): Map<string, unknown> {
  if (!(value instanceof Map)) throw new Error(`${at}: expected a mapping`);
  for (const key of value.keys()) {
    if (typeof key !== "string") throw new Error(`${at}: expected string keys`);
    if (fields && !fields.includes(key)) throw new Error(`${at}: unknown field ${key}`);
  }
  return value;
}
export function string(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${at}: expected a non-empty string`);
  return value;
}
export function regex(value: unknown, at: string): string {
  if (typeof value !== "string") throw new Error(`${at}: expected a regex string`);
  try { new RegExp(value, "i"); } catch { throw new Error(`${at}: invalid regex`); }
  return value;
}
export function sequence(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected a sequence`);
  return value;
}
export function version(value: unknown): void {
  if (value !== 1) throw new Error("version: expected 1");
}
