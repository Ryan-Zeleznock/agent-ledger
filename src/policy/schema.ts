import { parseConfigDocument, readConfigFile } from "../config-file.js";

/** Keep YAML mappings as Maps until validated; never coerce non-string keys. */
export async function readYaml(path: string): Promise<unknown> {
  return parseConfigDocument(readConfigFile(path)).toJS({ mapAsMap: true });
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
  compileRegex(value, at);
  return value as string;
}
export function sequence(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected a sequence`);
  return value;
}
export function version(value: unknown): void {
  if (value !== 1) throw new Error("version: expected 1");
}


/** Deliberately small regex subset: see README. Never run a pattern to validate its cost. */
export function compileRegex(value: unknown, at: string): RegExp {
  if (typeof value !== "string") throw new Error(`${at}: expected a regex string`);
  const unsafe = () => { throw new Error(`${at}: unsafe regex (outside the bounded subset)`); };
  if (value.length > 512) unsafe();
  let inClass = false, atom = false, quantifiers = 0;
  const groups = [{ paths: 1, alternatives: 0 }];
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "\\") {
      const escaped = value[++i];
      // No backreferences, legacy octal, named references, or multi-character escapes.
      if (!escaped || (/[A-Za-z0-9]/.test(escaped) && !/^[dDsSwWbBfnrtv]$/.test(escaped))) unsafe();
      atom = !/[bB]/.test(escaped!);
    } else if (inClass) {
      if (c === "]") { inClass = false; atom = true; }
    } else if (c === "[") {
      inClass = true;
    } else if (c === "(") {
      if (value[i + 1] === "?") {
        if (value[i + 2] !== ":") unsafe();
        i += 2;
      }
      groups.push({ paths: 1, alternatives: 0 });
      atom = false;
    } else if (c === ")" || c === "|" || c === "^" || c === "$") {
      const group = groups.at(-1)!;
      if (c === "|") { group.alternatives += group.paths; group.paths = 1; }
      if (c === ")") {
        if (groups.length === 1) throw new Error(`${at}: invalid regex`);
        groups.pop();
        groups.at(-1)!.paths *= group.paths + group.alternatives;
      }
      if (groups.at(-1)!.paths + groups.at(-1)!.alternatives > 256) unsafe();
      // In particular, groups can never be quantified (even fixed-count groups).
      atom = false;
    } else if (c === "*" || c === "+" || c === "?" || c === "{") {
      if (!atom || ++quantifiers > 1) unsafe();
      if (c === "{") {
        const match = /^\{(\d+)(?:,(\d*))?\}/.exec(value.slice(i));
        if (!match || Number(match[1]) > 1024 || (match[2] && Number(match[2]) > 1024)) unsafe();
        i += match![0].length - 1;
      }
      atom = false;
    } else {
      atom = true;
    }
  }
  // Check after the whole pattern: a quantifier can follow all the alternatives.
  if (quantifiers > 0 && groups[0]!.paths + groups[0]!.alternatives > 16) unsafe();
  try { return new RegExp(value, "i"); } catch { throw new Error(`${at}: invalid regex`); }
}
