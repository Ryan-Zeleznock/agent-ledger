import { assertJsonData } from "./validate.js";

/**
 * Redaction of tool arguments before hashing and storage (spec §9), rewritten after Astra's review (2026-09-30,
 * findings #2, #3, #4, #6). Three layers, applied at every nesting level of objects and arrays:
 *  1. KEY layer: a field whose (NFKC-normalised) name says "secret" has its WHOLE value replaced. A key that itself
 *     carries a secret shape (a token, an e-mail) is renamed; an original key is never copied into a placeholder.
 *  2. STRUCTURE layer: argv pairs (`["--password", "x"]`), header triples (`["Authorization", "Bearer", "x"]`) and
 *     name/value header objects (`{name: "Authorization", value: "x"}`).
 *  3. VALUE layer: a string that parses as JSON is redacted structurally; every other string goes through a
 *     LINEAR tokeniser (words, quoted spans with escapes, placeholders, punctuation) and rules on the token stream:
 *     `name=value` / `name: value` / `"name": "value"` assignments with quoted multi-word values, auth schemes
 *     (case-insensitive), URL credentials and query parameters, vendor token shapes, e-mail, plus percent/base64/hex
 *     decoding of a word when the decoded text itself contains a secret. Bounded regexes run only on the whole string
 *     for shapes that need it (SSN, Luhn-valid card numbers) and on single words of at most WORD_REGEX_MAX chars.
 * A placeholder is `[REDACTED:<kind>]` and only counts when it is the COMPLETE value, so `[REDACTED:x]hunter2` is
 * still a secret. Over-redaction is the accepted failure direction. Inputs must be JSON data (assertJsonData).
 */

const PLACEHOLDER = (kind: string) => `[REDACTED:${kind}]`;
const PLACEHOLDER_FULL = /^\[REDACTED:[a-z0-9][a-z0-9:#_-]*\]$/;
const PLACEHOLDER_AT = /\[REDACTED:[a-z0-9][a-z0-9:#_-]*\]/y;

const WORD_REGEX_MAX = 1024;    // longer words get only anchored single-attempt checks (still assignment/decoding checks)
const JSON_IN_STRING_MAX = 64 * 1024;
const DECODE_MAX = 64 * 1024;
const MAX_SCAN_DEPTH = 3;       // string → JSON-in-string → decoded → stop

// ---------- key classification ----------

/** Normalised key ENDS WITH one of these → secret. Longest first so the reported keyword is the most specific. */
const KEY_SUFFIXES = [
  "clientsecret", "credentials", "credential", "authorization", "passphrase", "privatekey", "accesskey", "secretkey",
  "setcookie", "password", "passwd", "apikey", "secret", "cookie", "token",
] as const;
/** Normalised key EQUALS one of these → secret. Exact, so `sort_key` and `author` stay. */
const KEY_EXACT = ["pwd", "pass", "auth", "bearer", "key", "ssn", "otp", "pin"] as const;
/** Substrings that make an assignment NAME (in free text) or an argv flag secret-bearing. Containment, on purpose. */
const NAME_KEYWORDS = ["password", "passwd", "passphrase", "secret", "token", "apikey", "privatekey", "accesskey", "authorization", "credential", "cookie"] as const;
const SCHEMES = new Set(["bearer", "basic", "digest", "negotiate"]);

const normalise = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[-_.\s]/g, "");
/** The keyword (from OUR lists, never the caller's text) that makes `key` secret, or null. */
export function secretKeyword(key: string): string | null {
  const k = normalise(key);
  if ((KEY_EXACT as readonly string[]).includes(k)) return k;
  for (const s of KEY_SUFFIXES) if (k.endsWith(s)) return s;
  return null;
}
export const isSecretKey = (key: string) => secretKeyword(key) !== null;
const nameHasKeyword = (name: string) => { const n = normalise(name); return NAME_KEYWORDS.some((k) => n.includes(k)); };

// ---------- whole-string passes (bounded quantifiers: linear) ----------

function redactPem(s: string): string {
  let out = ""; let i = 0;
  for (;;) {
    const b = s.indexOf("-----BEGIN ", i);
    if (b === -1) return out + s.slice(i);
    const hdrEnd = s.indexOf("PRIVATE KEY-----", b);
    if (hdrEnd === -1 || s.slice(b, hdrEnd).includes("\n")) { out += s.slice(i, b + 11); i = b + 11; continue; }
    const e = s.indexOf("-----END ", hdrEnd);
    const footEnd = e === -1 ? -1 : s.indexOf("PRIVATE KEY-----", e);
    const end = footEnd === -1 ? s.length : footEnd + "PRIVATE KEY-----".length;
    out += s.slice(i, b) + PLACEHOLDER("private-key");
    i = end;
  }
}
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
function luhnValid(s: string): boolean {
  const digits = s.replace(/[ -]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// ---------- per-word patterns (run on one bounded word) ----------

const WORD_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // No trailing \b: a token glued to a suffix (`ghp_…_password`, `AKIA…:x`) is still a token (Astra #3).
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|APKA|ASCA)[0-9A-Z]{16}/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { kind: "sk-token", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
];
/** Words longer than WORD_REGEX_MAX get only anchored, single-attempt checks. */
const LONG_WORD_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "jwt", re: /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/ },
];
const URL_CRED_RE = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]+)@/i;

const isLocalChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45; // [A-Za-z0-9._%+-]
const isDomainChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45;          // [A-Za-z0-9.-]
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** Linear e-mail finder: expand around each `@` (a regex with `[...]+@` backtracks quadratically on long runs). */
function redactEmails(w: string): string {
  if (!w.includes("@")) return w;
  let out = ""; let i = 0; let from = 0;
  while (i < w.length) {
    const at = w.indexOf("@", i);
    if (at === -1) break;
    let l = at; while (l > from && isLocalChar(w.charCodeAt(l - 1))) l--;
    let r = at + 1; while (r < w.length && isDomainChar(w.charCodeAt(r))) r++;
    const domain = w.slice(at + 1, r).replace(/\.+$/, "");
    const dot = domain.lastIndexOf(".");
    const tld = dot === -1 ? "" : domain.slice(dot + 1);
    const okTld = tld.length >= 2 && [...tld].every((ch) => isAlpha(ch.charCodeAt(0)));
    if (l < at && domain.length > dot + 1 && dot > 0 && okTld) {
      out += w.slice(from, l) + PLACEHOLDER("email");
      from = at + 1 + domain.length; i = from;
    } else {
      i = at + 1;
    }
  }
  return out + w.slice(from);
}

// ---------- tokeniser ----------

type TokType = "ws" | "word" | "quoted" | "punct" | "ph";
interface Tok { t: TokType; s: string }
const DELIMS = new Set([...'"\'`,;&|<>()[]{}']);
const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i]!;
    if (isWs(c)) { let j = i + 1; while (j < n && isWs(s[j]!)) j++; toks.push({ t: "ws", s: s.slice(i, j) }); i = j; continue; }
    if (c === "[") {
      PLACEHOLDER_AT.lastIndex = i;
      const m = PLACEHOLDER_AT.exec(s);
      if (m) { toks.push({ t: "ph", s: m[0] }); i += m[0].length; continue; }
      toks.push({ t: "punct", s: c }); i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && s[j] !== c) { if (s[j] === "\\") j++; j++; }
      const end = Math.min(j + 1, n);
      toks.push({ t: "quoted", s: s.slice(i, end) }); i = end; continue;
    }
    if (DELIMS.has(c)) { toks.push({ t: "punct", s: c }); i++; continue; }
    let j = i + 1;
    while (j < n && !isWs(s[j]!) && !DELIMS.has(s[j]!)) j++;
    toks.push({ t: "word", s: s.slice(i, j) }); i = j;
  }
  return toks;
}

const isValueTok = (tk: Tok | undefined) => tk !== undefined && (tk.t === "word" || tk.t === "quoted" || tk.t === "ph");
const skipWs = (toks: Tok[], i: number) => (i < toks.length && toks[i]!.t === "ws" ? i + 1 : i);
/** [start, end) of the adjacent value tokens beginning at `start` (words, quoted spans, placeholders). */
function valueRun(toks: Tok[], start: number): number {
  let end = start;
  while (isValueTok(toks[end])) end++;
  return end;
}
function unquote(q: string): { open: string; inner: string; closed: boolean } {
  const open = q[0]!;
  const closed = q.length >= 2 && q[q.length - 1] === open;
  return { open, inner: q.slice(1, closed ? -1 : undefined), closed };
}
/** Replacement for a value run: an already-complete placeholder (bare or quoted) stays, anything else is one placeholder. */
function replaceRun(toks: Tok[], start: number, end: number, kind: string): string {
  if (end - start === 1) {
    const tk = toks[start]!;
    if (tk.t === "ph") return tk.s;
    if (tk.t === "quoted") {
      const { open, inner, closed } = unquote(tk.s);
      if (PLACEHOLDER_FULL.test(inner)) return tk.s;
      return `${open}${PLACEHOLDER(kind)}${closed ? open : ""}`;
    }
  }
  return PLACEHOLDER(kind);
}

// ---------- token rules ----------

interface Consumed { text: string; next: number }

/** The value run at `valueStart`; a bare auth scheme word (`Bearer`) keeps its name and the credential after it is redacted. */
function consumeValue(toks: Tok[], valueStart: number, kind: string): Consumed | null {
  const end = valueRun(toks, valueStart);
  if (end === valueStart) return null;
  const first = toks[valueStart]!;
  if (end - valueStart === 1 && first.t === "word" && SCHEMES.has(first.s.toLowerCase())) {
    const j = skipWs(toks, end);
    const end2 = valueRun(toks, j);
    if (end2 > j) return { text: first.s + toks.slice(end, j).map((t) => t.s).join("") + replaceRun(toks, j, end2, first.s.toLowerCase()), next: end2 };
  }
  return { text: replaceRun(toks, valueStart, end, kind), next: end };
}

/** `name=value`, `name: value`, `"name": "value"`, `--flag value`, `name = value`; the name must carry a keyword. */
function tryAssignment(toks: Tok[], i: number): Consumed | null {
  const tk = toks[i]!;
  let name: string; let rest = ""; let afterName = i + 1; let sepInWord = false;
  if (tk.t === "quoted") {
    const { inner } = unquote(tk.s);
    if (inner.includes("=") || inner.includes(":")) return null;
    name = inner;
  } else {
    const eq = tk.s.indexOf("="); const colon = tk.s.indexOf(":");
    const idx = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    if (idx === -1) name = tk.s;
    else { name = tk.s.slice(0, idx); rest = tk.s.slice(idx + 1); sepInWord = true; }
  }
  if (!nameHasKeyword(name)) return null;
  let head = tk.s;
  let valueStart: number;
  if (sepInWord) {
    head = tk.s.slice(0, name.length + 1);
    valueStart = i + 1;
    if (rest.length === 0) valueStart = skipWs(toks, i + 1);
  } else if (tk.t === "word" && tk.s.startsWith("-")) {
    valueStart = skipWs(toks, i + 1);                       // argv: `--password hunter2`
    if (!isValueTok(toks[valueStart]) || toks[valueStart]!.s.startsWith("-")) return null;
    const v = consumeValue(toks, valueStart, "argv")!;
    return { text: head + toks.slice(i + 1, valueStart).map((t) => t.s).join("") + v.text, next: v.next };
  } else {
    const j = skipWs(toks, afterName);
    const sep = toks[j];
    if (sep === undefined || sep.t !== "word" || !(sep.s.startsWith("=") || sep.s.startsWith(":"))) return null;
    rest = sep.s.slice(1);
    head = tk.s + toks.slice(i + 1, j).map((t) => t.s).join("") + sep.s[0]!;
    valueStart = rest.length === 0 ? skipWs(toks, j + 1) : j + 1;
    afterName = j + 1;
    if (rest.length === 0) head += toks.slice(j + 1, valueStart).map((t) => t.s).join("");
  }
  if (rest.length > 0) {
    // value begins inside the separator word; adjacent value tokens belong to it too
    const end = valueRun(toks, valueStart);
    if (end === valueStart && PLACEHOLDER_FULL.test(rest)) return { text: head + rest, next: valueStart };
    return { text: head + PLACEHOLDER("assignment"), next: end };
  }
  if (sepInWord) head += toks.slice(i + 1, valueStart).map((t) => t.s).join("");
  const v = consumeValue(toks, valueStart, "assignment");
  if (v === null) return null; // nothing after the separator
  return { text: head + v.text, next: v.next };
}

/** `Bearer xyz`, `basic dXNlcjpwYXNz` (case-insensitive): the next value run is the credential. */
function tryScheme(toks: Tok[], i: number): Consumed | null {
  const tk = toks[i]!;
  if (tk.t !== "word") return null;
  const scheme = tk.s.toLowerCase();
  if (!SCHEMES.has(scheme)) return null;
  const valueStart = skipWs(toks, i + 1);
  const end = valueRun(toks, valueStart);
  if (end === valueStart) return null;
  return { text: tk.s + toks.slice(i + 1, valueStart).map((t) => t.s).join("") + replaceRun(toks, valueStart, end, scheme), next: end };
}

// ---------- word-level ----------

function printableRatio(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let ok = 0;
  for (const b of buf) if ((b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09) ok++;
  return ok / buf.length;
}
/** Percent-, base64- or hex-encoded text whose DECODED form carries a secret → the whole word is a secret. */
function decodedHasSecret(word: string, depth: number): boolean {
  if (depth >= MAX_SCAN_DEPTH || word.length > DECODE_MAX) return false;
  const candidates: string[] = [];
  if (/%[0-9A-Fa-f]{2}/.test(word)) { try { const d = decodeURIComponent(word); if (d !== word) candidates.push(d); } catch { /* not percent-encoded */ } }
  if (word.length >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(word)) {
    const buf = Buffer.from(word.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length >= 8 && printableRatio(buf) >= 0.9) candidates.push(buf.toString("utf8"));
  }
  if (word.length >= 32 && word.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(word)) {
    const buf = Buffer.from(word, "hex");
    if (printableRatio(buf) >= 0.9) candidates.push(buf.toString("latin1"));
  }
  return candidates.some((c) => scanString(c, depth + 1) !== c);
}

function redactWord(word: string, depth: number): string {
  let w = word;
  if (w.includes("://") && w.length <= WORD_REGEX_MAX) w = w.replace(URL_CRED_RE, (_m, scheme: string) => `${scheme}${PLACEHOLDER("url-credentials")}@`);
  const q = w.indexOf("?");
  if (q !== -1) {
    // first query parameter lives in this word (`&` splits words); `name=value` with a keyword name
    const param = w.slice(q + 1);
    const eq = param.indexOf("=");
    if (eq > 0 && nameHasKeyword(param.slice(0, eq)) && eq + 1 < param.length && !PLACEHOLDER_FULL.test(param.slice(eq + 1))) {
      w = `${w.slice(0, q + 1)}${param.slice(0, eq + 1)}${PLACEHOLDER("assignment")}`;
    }
  }
  if (w.length <= WORD_REGEX_MAX) {
    for (const p of WORD_PATTERNS) { p.re.lastIndex = 0; w = w.replace(p.re, PLACEHOLDER(p.kind)); }
    w = redactEmails(w);
  } else {
    for (const p of LONG_WORD_PATTERNS) if (p.re.test(w)) return PLACEHOLDER(p.kind);
  }
  if (w === word && decodedHasSecret(word, depth)) return PLACEHOLDER("encoded");
  return w;
}

function scanTokens(toks: Tok[], depth: number): string {
  let out = "";
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i]!;
    if (tk.t === "word" || tk.t === "quoted") {
      const a = tryAssignment(toks, i);
      if (a) { out += a.text; i = a.next; continue; }
    }
    if (tk.t === "word") {
      const sch = tryScheme(toks, i);
      if (sch) { out += sch.text; i = sch.next; continue; }
      out += redactWord(tk.s, depth); i++; continue;
    }
    if (tk.t === "quoted") {
      const { open, inner, closed } = unquote(tk.s);
      out += `${open}${scanString(inner, depth + 1)}${closed ? open : ""}`; i++; continue;
    }
    out += tk.s; i++;
  }
  return out;
}

/** JSON carried inside a string (`JSON.stringify(...)` in a command) is redacted structurally and re-serialised. */
function tryJsonInString(s: string, depth: number): string | null {
  if (s.length > JSON_IN_STRING_MAX) return null;
  const first = s.trimStart()[0];
  if (first !== "{" && first !== "[") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  return JSON.stringify(redactValue(parsed, depth + 1, new WeakSet()));
}

export function scanString(s: string, depth = 0): string {
  if (depth > MAX_SCAN_DEPTH || s.length === 0) return s;
  if (PLACEHOLDER_FULL.test(s)) return s;
  const asJson = tryJsonInString(s, depth);
  if (asJson !== null) return asJson;
  let out = redactPem(s);
  SSN_RE.lastIndex = 0; out = out.replace(SSN_RE, PLACEHOLDER("ssn"));
  CARD_RE.lastIndex = 0; out = out.replace(CARD_RE, (m) => (luhnValid(m) ? PLACEHOLDER("card-number") : m));
  return scanTokens(tokenize(out), depth);
}
export const redactString = (s: string) => scanString(s, 0);

// ---------- structure ----------

const PAIR_NAME_KEYS = ["name", "key", "header", "field"] as const;

function redactArray(arr: unknown[], depth: number, seen: WeakSet<object>): unknown[] {
  const out: unknown[] = [];
  let redactNext = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (redactNext > 0 && typeof x === "string") {
      redactNext--;
      const lower = x.toLowerCase();
      out.push(PLACEHOLDER_FULL.test(x) ? x : SCHEMES.has(lower) ? x : PLACEHOLDER("pair"));
      if (SCHEMES.has(lower)) redactNext = 1;                   // ["Authorization", "Bearer", "<credential>"]
      continue;
    }
    redactNext = 0;
    if (typeof x === "string") {
      if (/^--?[^\s=:]+$/.test(x) && nameHasKeyword(x)) redactNext = 1;    // ["--password", "hunter2"]
      else if (isSecretKey(x)) redactNext = 1;                              // ["Authorization", "..."], ["password", "..."]
    }
    out.push(redactValue(x, depth + 1, seen));
  }
  return out;
}

function redactObject(o: Record<string, unknown>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(o);
  // header objects: { name: "Authorization", value: "..." }
  let pairValueKey: string | null = null;
  if (Object.hasOwn(o, "value")) {
    for (const nk of PAIR_NAME_KEYS) {
      const nv = o[nk];
      if (typeof nv === "string" && isSecretKey(nv)) { pairValueKey = "value"; break; }
    }
  }
  let renamed = 0;
  for (const key of keys) {
    const kw = secretKeyword(key);
    const keyLeaks = scanString(key, 1) !== key;
    let outKey = key;
    if (keyLeaks) {
      do { outKey = `[REDACTED:key#${++renamed}]`; } while (Object.hasOwn(out, outKey) || keys.includes(outKey));
    }
    let value: unknown;
    if (kw !== null) value = PLACEHOLDER(`key:${kw}`);
    else if (key === pairValueKey) value = typeof o[key] === "string" && PLACEHOLDER_FULL.test(o[key] as string) ? o[key] : PLACEHOLDER("pair");
    else value = redactValue(o[key], depth + 1, seen);
    // defineProperty, not assignment: a JSON key named `__proto__` must become data, never the prototype.
    Object.defineProperty(out, outKey, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function redactValue(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof v === "string") return scanString(v, 0);
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v)) throw new Error("ledger.redact: circular reference in args");
  seen.add(v);
  try {
    return Array.isArray(v) ? redactArray(v, depth, seen) : redactObject(v as Record<string, unknown>, depth, seen);
  } finally {
    seen.delete(v);
  }
}

/** Public entry: validates the JSON-only boundary and limits first, then redacts. Never mutates its input. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  assertJsonData(args, "args");
  return redactValue(args, 0, new WeakSet()) as Record<string, unknown>;
}
