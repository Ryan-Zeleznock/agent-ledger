import { assertJsonData, MAX_DEPTH } from "./validate.js";

/**
 * Redaction of tool arguments before hashing and storage (spec §9). Rewritten after Astra's reviews (2026-09-30).
 * DESIGN NOTE: redaction is best-effort defence in depth. Pattern matching cannot prove the absence of a secret, so the
 * ledger never relies on it as its only control: the pipeline strips credentials by projection (spec §5), the
 * JSON-only boundary (validate.ts) runs before AND after redaction, and over-redaction is the accepted failure direction.
 *
 * Three layers, applied at every nesting level of objects and arrays:
 *  1. KEY layer: a field whose (NFKC-normalised) name says "secret" has its WHOLE value replaced with a placeholder
 *     naming OUR keyword. A key that itself carries a secret shape is renamed `[REDACTED:key#n]` (collision-safe, Set-based).
 *  2. STRUCTURE layer: argv pairs (`["--password", "x"]`), header triples (`["Authorization", "Bearer", "x"]`) and
 *     name/value header objects (`{name: "Authorization", value: "x"}`).
 *  3. VALUE layer: a string that parses as JSON (within the remaining depth budget) is redacted structurally; every
 *     other string goes through a LINEAR, NON-RECURSIVE tokeniser (whitespace, words, placeholders, punctuation incl.
 *     quotes) and rules on the token stream: assignments `name=value` / `name: value` / `"name": "value"` /
 *     `name = value` / `--flag value` whose name carries a keyword (values may be quoted with escapes, multi-word,
 *     unterminated, or start with an auth scheme), auth schemes (case-insensitive), URL userinfo and query parameters,
 *     vendor token shapes, e-mail (hand-rolled), and ONE level of percent/base64/hex decoding when the decoded text
 *     itself carries a secret. Words longer than WORD_MAX are replaced whole (`[REDACTED:long-word]`): fail safe rather
 *     than leave them unscanned. On the whole string only linear scans run: PEM blocks (indexOf, no rescans) and
 *     bounded-quantifier regexes for SSNs and Luhn-valid card numbers.
 * A placeholder `[REDACTED:<kind>]` counts only when it is the COMPLETE value. Inputs must be JSON data.
 */

const PLACEHOLDER = (kind: string) => `[REDACTED:${kind}]`;
const PLACEHOLDER_FULL = /^\[REDACTED:[a-z0-9][a-z0-9:#_-]*\]$/;
const PLACEHOLDER_AT = /\[REDACTED:[a-z0-9][a-z0-9:#_-]*\]/y;

export const WORD_MAX = 1024;         // longer words are replaced whole
const JSON_IN_STRING_MAX = 64 * 1024;
const DECODE_MAX = 64 * 1024;

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
const isScheme = (s: string) => SCHEMES.has(s.toLowerCase());

// ---------- whole-string passes (linear) ----------

const BEGIN = "-----BEGIN "; const END = "-----END "; const PK = "PRIVATE KEY-----";
/** PEM private-key blocks. Every indexOf starts where the previous one stopped; a missing footer is remembered, never re-searched. */
function redactPem(s: string): string {
  let out = ""; let i = 0; let noEndAfter = -1;
  for (;;) {
    const b = s.indexOf(BEGIN, i);
    if (b === -1) return out + s.slice(i);
    const header = s.slice(b, b + 80); // "-----BEGIN <TYPE> PRIVATE KEY-----" fits; bounded window
    const h = header.indexOf(PK);
    if (h === -1 || header.slice(0, h).includes("\n")) { out += s.slice(i, b + BEGIN.length); i = b + BEGIN.length; continue; }
    out += s.slice(i, b) + PLACEHOLDER("private-key");
    const bodyStart = b + h + PK.length;
    const end = noEndAfter !== -1 && noEndAfter <= bodyStart ? -1 : s.indexOf(END, bodyStart);
    if (end === -1) noEndAfter = bodyStart;
    const nextBegin = s.indexOf(BEGIN, bodyStart);
    if (end === -1 && nextBegin === -1) return out;                // no footer, no further header: the rest is key body
    if (end !== -1 && (nextBegin === -1 || end < nextBegin)) {      // proper footer
      const footer = s.slice(end, end + 80); const f = footer.indexOf(PK);
      i = f === -1 ? end + END.length : end + f + PK.length;
    } else {
      i = nextBegin;                                                 // another header before any footer: body ran until it
    }
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

// ---------- per-word patterns (run on one word of at most WORD_MAX chars) ----------

const WORD_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // No trailing \b: a token glued to a suffix (`ghp_…_password`, `AKIA…:x`) is still a token.
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|APKA|ASCA)[0-9A-Z]{16}/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { kind: "sk-token", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
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
    if (l < at && dot > 0 && okTld) {
      out += w.slice(from, l) + PLACEHOLDER("email");
      from = at + 1 + domain.length; i = from;
    } else {
      i = at + 1;
    }
  }
  return out + w.slice(from);
}

// ---------- tokeniser (no recursion: quotes are punctuation) ----------

type TokType = "ws" | "word" | "punct" | "ph";
interface Tok { t: TokType; s: string }
const DELIMS = new Set([...'"\'`,;&|<>()[]{}']);
const QUOTES = new Set(['"', "'", "`"]);
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
    if (DELIMS.has(c)) { toks.push({ t: "punct", s: c }); i++; continue; }
    let j = i + 1;
    while (j < n && !isWs(s[j]!) && !DELIMS.has(s[j]!)) j++;
    toks.push({ t: "word", s: s.slice(i, j) }); i = j;
  }
  return toks;
}

const isValueTok = (tk: Tok | undefined) => tk !== undefined && (tk.t === "word" || tk.t === "ph");
const isQuote = (tk: Tok | undefined) => tk !== undefined && tk.t === "punct" && QUOTES.has(tk.s);
const skipWs = (toks: Tok[], i: number) => (i < toks.length && toks[i]!.t === "ws" ? i + 1 : i);
const join = (toks: Tok[], from: number, to: number) => { let s = ""; for (let k = from; k < to; k++) s += toks[k]!.s; return s; };
/** [start, end) of the adjacent value tokens beginning at `start` (words and placeholders). */
function valueRun(toks: Tok[], start: number): number { let end = start; while (isValueTok(toks[end])) end++; return end; }
/** A quote token is escaped when the token before it is a word ending in an odd number of backslashes. */
function escaped(toks: Tok[], j: number): boolean {
  const prev = toks[j - 1];
  if (prev === undefined || prev.t !== "word") return false;
  let n = 0; for (let k = prev.s.length - 1; k >= 0 && prev.s[k] === "\\"; k--) n++;
  return n % 2 === 1;
}
/** Index of the quote closing the one at `open`, or -1 when unterminated. Linear: each token is visited once. */
function closingQuote(toks: Tok[], open: number): number {
  const q = toks[open]!.s;
  for (let j = open + 1; j < toks.length; j++) if (toks[j]!.t === "punct" && toks[j]!.s === q && !escaped(toks, j)) return j;
  return -1;
}

interface Consumed { text: string; next: number }
/** Replaces the value starting at `start`: a quoted span (escape-aware, unterminated = to the end), or a run of words/placeholders. */
function replaceValueAt(toks: Tok[], start: number, kind: string): Consumed | null {
  const tk = toks[start];
  if (tk === undefined) return null;
  if (isQuote(tk)) {
    const close = closingQuote(toks, start);
    const innerEnd = close === -1 ? toks.length : close;
    if (innerEnd === start + 1) return null;                                   // empty quotes: nothing to redact
    const inner = toks.slice(start + 1, innerEnd);
    if (inner.length === 1 && inner[0]!.t === "ph") return { text: join(toks, start, innerEnd) + (close === -1 ? "" : tk.s), next: innerEnd + (close === -1 ? 0 : 1) };
    return { text: `${tk.s}${PLACEHOLDER(kind)}${close === -1 ? "" : tk.s}`, next: close === -1 ? toks.length : close + 1 };
  }
  if (!isValueTok(tk)) return null;
  const end = valueRun(toks, start);
  if (end - start === 1 && tk.t === "word" && isScheme(tk.s)) {               // `Bearer <credential>`
    const j = skipWs(toks, end);
    const v = replaceValueAt(toks, j, tk.s.toLowerCase());
    if (v) return { text: tk.s + join(toks, end, j) + v.text, next: v.next };
  }
  if (end - start === 1 && tk.t === "ph") return { text: tk.s, next: end };  // already redacted
  return { text: PLACEHOLDER(kind), next: end };
}

// ---------- token rules ----------

/**
 * Assignments whose NAME carries a keyword: `name=value`, `name:value`, `name: value`, `name = value`, `"name": "value"`,
 * `--flag value`, `authorization:bearer <credential>`. Returns the replacement text and the index to continue from.
 */
function tryAssignment(toks: Tok[], i: number): Consumed | null {
  const tk = toks[i]!;
  const eq = tk.s.indexOf("="); const colon = tk.s.indexOf(":");
  const idx = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
  let name: string; let rest: string; let head: string; let after: number;
  if (idx !== -1) {
    name = tk.s.slice(0, idx); rest = tk.s.slice(idx + 1);
    if (!nameHasKeyword(name)) return null;
    head = tk.s.slice(0, idx + 1); after = i + 1;
  } else {
    if (!nameHasKeyword(tk.s)) return null;
    if (tk.s.startsWith("-")) {                                                // argv: `--password hunter2`
      const vs = skipWs(toks, i + 1);
      if (toks[vs]?.t === "word" && toks[vs]!.s.startsWith("-")) return null;
      const v = replaceValueAt(toks, vs, "argv");
      return v ? { text: tk.s + join(toks, i + 1, vs) + v.text, next: v.next } : null;
    }
    let j = i + 1;
    if (isQuote(toks[j])) j++;                                                 // `"password": ...` (closing quote of the name)
    j = skipWs(toks, j);
    const sep = toks[j];
    if (sep === undefined || sep.t !== "word" || !(sep.s.startsWith("=") || sep.s.startsWith(":"))) return null;
    name = tk.s; rest = sep.s.slice(1);
    head = join(toks, i, j) + sep.s[0]!; after = j + 1;
  }
  if (rest.length > 0) {
    if (isScheme(rest)) {                                                      // `authorization:bearer X`
      const vs = skipWs(toks, after);
      const v = replaceValueAt(toks, vs, rest.toLowerCase());
      if (v) return { text: head + rest + join(toks, after, vs) + v.text, next: v.next };
    }
    const end = valueRun(toks, after);                                         // value began inside the word; adjacent tokens belong to it
    if (end === after && PLACEHOLDER_FULL.test(rest)) return { text: head + rest, next: after };
    return { text: head + PLACEHOLDER("assignment"), next: end };
  }
  const vs = skipWs(toks, after);
  const v = replaceValueAt(toks, vs, "assignment");
  return v ? { text: head + join(toks, after, vs) + v.text, next: v.next } : null;
}

/** `Bearer xyz`, `basic dXNlcjpwYXNz` (case-insensitive): the next value is the credential. */
function tryScheme(toks: Tok[], i: number): Consumed | null {
  const tk = toks[i]!;
  if (!isScheme(tk.s)) return null;
  const vs = skipWs(toks, i + 1);
  const v = replaceValueAt(toks, vs, tk.s.toLowerCase());
  return v ? { text: tk.s + join(toks, i + 1, vs) + v.text, next: v.next } : null;
}

// ---------- word-level ----------

function printableRatio(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let ok = 0;
  for (const b of buf) if ((b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09) ok++;
  return ok / buf.length;
}
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/; const HEX_RE = /^[0-9A-Fa-f]+$/;
/** Percent-, base64- or hex-encoded text whose DECODED form carries a secret. Exactly ONE level: the decoded text is scanned with decoding off. */
function decodedHasSecret(word: string): boolean {
  if (word.length > DECODE_MAX) return false;
  const candidates: string[] = [];
  if (/%[0-9A-Fa-f]{2}/.test(word)) { try { const d = decodeURIComponent(word); if (d !== word) candidates.push(d); } catch { /* not percent-encoded */ } }
  if (word.length >= 8 && B64_RE.test(word) && word.length % 4 !== 1) {       // unpadded base64/base64url has length ≡ 0, 2 or 3 (mod 4)
    const buf = Buffer.from(word.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length >= 4 && printableRatio(buf) >= 0.9) candidates.push(buf.toString("utf8"));
  }
  if (word.length >= 8 && word.length % 2 === 0 && HEX_RE.test(word)) {
    const buf = Buffer.from(word, "hex");
    if (printableRatio(buf) >= 0.9) candidates.push(buf.toString("latin1"));
  }
  return candidates.some((c) => scanString(c, 0, true) !== c);
}

function redactWord(word: string, decoded: boolean): string {
  if (word.length > WORD_MAX) return PLACEHOLDER("long-word");                // fail safe: never leave a long word unscanned
  let w = word;
  if (w.includes("://")) w = w.replace(URL_CRED_RE, (_m, scheme: string) => `${scheme}${PLACEHOLDER("url-credentials")}@`);
  const q = w.indexOf("?");
  if (q !== -1) {                                                              // first query parameter lives in this word (`&` splits words)
    const param = w.slice(q + 1);
    const e = param.indexOf("=");
    if (e > 0 && nameHasKeyword(param.slice(0, e)) && e + 1 < param.length && !PLACEHOLDER_FULL.test(param.slice(e + 1))) {
      w = `${w.slice(0, q + 1)}${param.slice(0, e + 1)}${PLACEHOLDER("assignment")}`;
    }
  }
  for (const p of WORD_PATTERNS) { p.re.lastIndex = 0; w = w.replace(p.re, PLACEHOLDER(p.kind)); }
  w = redactEmails(w);
  if (w === word && !decoded && decodedHasSecret(word)) return PLACEHOLDER("encoded");
  return w;
}

function scanTokens(toks: Tok[], decoded: boolean): string {
  let out = "";
  let i = 0;
  while (i < toks.length) {
    const tk = toks[i]!;
    if (tk.t === "word") {
      const a = tryAssignment(toks, i) ?? tryScheme(toks, i);
      if (a) { out += a.text; i = a.next; continue; }
      out += redactWord(tk.s, decoded); i++; continue;
    }
    out += tk.s; i++;
  }
  return out;
}

/** Depth of parsed JSON, measured iteratively; stops early once `limit` is exceeded. */
function jsonDepth(v: unknown, limit: number): number {
  let max = 0;
  const stack: { v: unknown; d: number }[] = [{ v, d: 1 }];
  while (stack.length > 0) {
    const { v: x, d } = stack.pop()!;
    if (typeof x !== "object" || x === null) continue;
    if (d > max) max = d;
    if (max > limit) return max;
    for (const child of Array.isArray(x) ? x : Object.values(x)) stack.push({ v: child, d: d + 1 });
  }
  return max;
}

/** JSON carried inside a string is redacted structurally when it fits the remaining depth budget; otherwise the tokeniser handles it. */
function tryJsonInString(s: string, depth: number, decoded: boolean): string | null {
  if (s.length > JSON_IN_STRING_MAX) return null;
  const first = s.trimStart()[0];
  if (first !== "{" && first !== "[") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return null; }                       // includes RangeError on absurd nesting
  if (typeof parsed !== "object" || parsed === null) return null;
  const remaining = MAX_DEPTH - depth;
  if (remaining < 1 || jsonDepth(parsed, remaining) > remaining) return null;
  return JSON.stringify(redactValue(parsed, depth + 1, new WeakSet(), decoded));
}

/** Redacts one string. `depth` is the structural depth already consumed; `decoded` marks text produced by one decode step. */
export function scanString(s: string, depth = 0, decoded = false): string {
  if (s.length === 0 || PLACEHOLDER_FULL.test(s)) return s;
  const asJson = tryJsonInString(s, depth, decoded);
  if (asJson !== null) return asJson;
  let out = redactPem(s);
  SSN_RE.lastIndex = 0; out = out.replace(SSN_RE, PLACEHOLDER("ssn"));
  CARD_RE.lastIndex = 0; out = out.replace(CARD_RE, (m) => (luhnValid(m) ? PLACEHOLDER("card-number") : m));
  return scanTokens(tokenize(out), decoded);
}
export const redactString = (s: string) => scanString(s, 0, false);

// ---------- structure ----------

const PAIR_NAME_KEYS = ["name", "key", "header", "field"] as const;

function redactArray(arr: unknown[], depth: number, seen: WeakSet<object>, decoded: boolean): unknown[] {
  const out: unknown[] = [];
  let redactNext = 0;
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (redactNext > 0 && typeof x === "string") {
      redactNext--;
      const scheme = isScheme(x);
      out.push(PLACEHOLDER_FULL.test(x) || scheme ? x : PLACEHOLDER("pair"));
      if (scheme) redactNext = 1;                                              // ["Authorization", "Bearer", "<credential>"]
      continue;
    }
    redactNext = 0;
    if (typeof x === "string") {
      if (/^--?[^\s=:]+$/.test(x) && nameHasKeyword(x)) redactNext = 1;       // ["--password", "hunter2"]
      else if (isSecretKey(x)) redactNext = 1;                                 // ["Authorization", "..."], ["password", "..."]
    }
    out.push(redactValue(x, depth + 1, seen, decoded));
  }
  return out;
}

function redactObject(o: Record<string, unknown>, depth: number, seen: WeakSet<object>, decoded: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(o);
  const taken = new Set(keys);                                                 // Set, not Array#includes: renaming stays linear
  let pairValueKey: string | null = null;                                      // header objects: { name: "Authorization", value: "..." }
  if (Object.hasOwn(o, "value")) {
    for (const nk of PAIR_NAME_KEYS) {
      const nv = o[nk];
      if (typeof nv === "string" && isSecretKey(nv)) { pairValueKey = "value"; break; }
    }
  }
  let renamed = 0;
  for (const key of keys) {
    const kw = secretKeyword(key);
    let outKey = key;
    if (scanString(key, depth, decoded) !== key) {                             // the key itself carries a secret or PII shape
      do { outKey = `[REDACTED:key#${++renamed}]`; } while (taken.has(outKey));
      taken.add(outKey);
    }
    let value: unknown;
    if (kw !== null) value = PLACEHOLDER(`key:${kw}`);
    else if (key === pairValueKey) value = typeof o[key] === "string" && PLACEHOLDER_FULL.test(o[key] as string) ? o[key] : PLACEHOLDER("pair");
    else value = redactValue(o[key], depth + 1, seen, decoded);
    // defineProperty, not assignment: a JSON key named `__proto__` must become data, never the prototype.
    Object.defineProperty(out, outKey, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function redactValue(v: unknown, depth: number, seen: WeakSet<object>, decoded: boolean): unknown {
  if (depth > MAX_DEPTH) throw new Error(`ledger.redact: nesting deeper than ${MAX_DEPTH}`);   // unreachable after snapshot + jsonDepth checks
  if (typeof v === "string") return scanString(v, depth, decoded);
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v)) throw new Error("ledger.redact: circular reference in args");
  seen.add(v);
  try {
    return Array.isArray(v) ? redactArray(v, depth, seen, decoded) : redactObject(v as Record<string, unknown>, depth, seen, decoded);
  } finally {
    seen.delete(v);
  }
}

/** Public entry: validates the JSON-only boundary and limits first (on a snapshot), then redacts. Never mutates its input. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  assertJsonData(args, "args");
  return redactValue(args, 0, new WeakSet(), false) as Record<string, unknown>;
}
