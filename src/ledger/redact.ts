import { assertJsonData, MAX_DEPTH } from "./validate.js";

/**
 * Redaction of tool arguments before hashing and storage (spec §9). Rewritten after Astra's reviews (2026-09-30, three rounds).
 * DESIGN NOTE: redaction is best-effort defence in depth. Pattern matching cannot prove the absence of a secret, so the
 * ledger never relies on it as its only control: the pipeline strips credentials by projection (spec §5), the
 * JSON-only boundary (validate.ts) runs before AND after redaction, and over-redaction is the accepted failure direction.
 *
 * Three layers, applied at every nesting level of objects and arrays:
 *  1. KEY layer: a field whose (NFKC-normalised) name ends with, equals, or CONTAINS a sensitive word
 *     (`db_password_value`, `api_key_value`) has its WHOLE value replaced with a placeholder naming OUR keyword. A key
 *     that itself carries a secret shape is renamed `[REDACTED:key#n]` (collision-safe, Set-based).
 *  2. STRUCTURE layer: argv pairs (`["--password", "x"]`, `["-p", "x"]`, next argument even if it starts with `-`),
 *     header triples (`["Authorization", "Bearer", "x"]`) and name/value header objects (`{name: "Cookie", value: "x"}`).
 *  3. VALUE layer: a string that parses as JSON (within the remaining depth budget) is redacted structurally; every
 *     other string goes through a LINEAR, NON-RECURSIVE tokeniser and format-aware rules (round 3):
 *     - `NAME=VALUE` / `NAME: VALUE` / `"NAME": "VALUE"` / `NAME = VALUE` whose name is sensitive: a quoted value is
 *       redacted to its closing quote (escape-aware; unterminated = to the end); an unquoted value is redacted to the
 *       END OF THE LINE. That one boundary covers `Authorization: <any scheme> <cred>`, `Cookie: a=b; c=d`,
 *       `PASSWORD=alpha,beta`, `PASS=x`, `?pwd=` and `TOKEN=x && echo` (the tail is lost: accepted over-redaction).
 *     - CLI flags `--password`, `--token`, `--secret`, `--auth`, `-p`, ... : the next argument, even if it starts with `-`.
 *     - URLs anywhere in a word (also inside `DATABASE_URL=...`): userinfo replaced entirely (commas included);
 *       sensitive query parameters redacted up to the next `&` or `#`.
 *     - auth schemes in prose (`Bearer x`), vendor token shapes, e-mail (hand-rolled), ONE level of percent/base64/hex
 *       decoding when the decoded text carries a secret, words longer than WORD_MAX replaced whole, PEM blocks, SSNs,
 *       Luhn-valid card numbers.
 * A placeholder `[REDACTED:<kind>]` counts only when it is the COMPLETE value. Inputs must be JSON data.
 */

const PLACEHOLDER = (kind: string) => `[REDACTED:${kind}]`;
const PLACEHOLDER_FULL = /^\[REDACTED:[a-z0-9][a-z0-9:#_-]*\]$/;
/**
 * ADR-009 (2026-09-30): a value that is EXACTLY a keyed digest `hmac-sha256:<64 hex>` is already-protected evidence the
 * pipeline stored in place of a non-allowlisted argument. The key layer keeps it even under a sensitive field NAME
 * (`password: "hmac-sha256:…"`), otherwise two different passwords would persist as the same placeholder and the
 * auditor holding the key could verify neither. Nothing else is exempt: the token shape carries no secret by itself.
 */
const HMAC_DIGEST_FULL = /^hmac-sha256:[0-9a-f]{64}$/;
const isProtected = (v: unknown): boolean => typeof v === "string" && (PLACEHOLDER_FULL.test(v) || HMAC_DIGEST_FULL.test(v));
const PLACEHOLDER_AT = /\[REDACTED:[a-z0-9][a-z0-9:#_-]*\]/y;

export const WORD_MAX = 1024;         // longer words are replaced whole
const JSON_IN_STRING_MAX = 64 * 1024;
const DECODE_MAX = 64 * 1024;

// ---------- sensitivity ----------

/** Normalised key ENDS WITH one of these → secret. Longest first so the reported keyword is the most specific. */
const KEY_SUFFIXES = [
  "clientsecret", "credentials", "credential", "authorization", "passphrase", "privatekey", "accesskey", "secretkey",
  "setcookie", "password", "passwd", "apikey", "secret", "cookie", "token",
] as const;
/** Normalised key EQUALS one of these → secret. */
const KEY_EXACT = ["pwd", "pass", "auth", "bearer", "key", "ssn", "otp", "pin"] as const;
/** Normalised key or assignment name CONTAINS one of these → secret (`db_password_value`, `x-auth-token`, `?access_token=`). */
const CONTAINS = ["password", "passwd", "passphrase", "secret", "token", "apikey", "privatekey", "accesskey", "authorization", "credential", "cookie"] as const;
/** Bare CLI flag names (after the dashes) that take a secret as the NEXT argument. */
const FLAG_EXACT = new Set(["p", "auth", "pass", "pwd", "key", "u"]);
const SCHEMES = new Set(["bearer", "basic", "digest", "negotiate"]);

const normalise = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[-_.\s]/g, "");
/** The keyword (from OUR lists, never the caller's text) that makes `name` secret, or null. */
export function secretKeyword(name: string): string | null {
  const k = normalise(name);
  if ((KEY_EXACT as readonly string[]).includes(k)) return k;
  for (const s of KEY_SUFFIXES) if (k.endsWith(s)) return s;
  for (const c of CONTAINS) if (k.includes(c)) return c;
  return null;
}
export const isSecretKey = (name: string) => secretKeyword(name) !== null;
const isScheme = (s: string) => SCHEMES.has(s.toLowerCase());
/** `--password`, `-p`, `--auth`, `--db-token`: a flag whose next argument is a secret. */
function flagIsSensitive(flag: string): boolean {
  if (!/^--?[^\s=:]+$/.test(flag)) return false;
  const bare = flag.replace(/^-+/, "");
  return FLAG_EXACT.has(normalise(bare)) || secretKeyword(bare) !== null;
}

// ---------- whole-string passes (linear) ----------

const BEGIN = "-----BEGIN "; const END = "-----END "; const PK = "PRIVATE KEY-----";
/** PEM private-key blocks. Every indexOf starts where the previous one stopped; a missing footer is remembered, never re-searched. */
function redactPem(s: string): string {
  let out = ""; let i = 0; let noEndAfter = -1;
  for (;;) {
    const b = s.indexOf(BEGIN, i);
    if (b === -1) return out + s.slice(i);
    const header = s.slice(b, b + 80);
    const h = header.indexOf(PK);
    if (h === -1 || header.slice(0, h).includes("\n")) { out += s.slice(i, b + BEGIN.length); i = b + BEGIN.length; continue; }
    out += s.slice(i, b) + PLACEHOLDER("private-key");
    const bodyStart = b + h + PK.length;
    const end = noEndAfter !== -1 && noEndAfter <= bodyStart ? -1 : s.indexOf(END, bodyStart);
    if (end === -1) noEndAfter = bodyStart;
    const nextBegin = s.indexOf(BEGIN, bodyStart);
    if (end === -1 && nextBegin === -1) return out;
    if (end !== -1 && (nextBegin === -1 || end < nextBegin)) {
      const footer = s.slice(end, end + 80); const f = footer.indexOf(PK);
      i = f === -1 ? end + END.length : end + f + PK.length;
    } else {
      i = nextBegin;
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
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|APKA|ASCA)[0-9A-Z]{16}/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { kind: "sk-token", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
];
/** Unanchored: the URL may sit after `DATABASE_URL=`; userinfo runs to the `@` (commas and colons included), bounded by the word. */
const URL_CRED_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/@]+)@/i;

const isLocalChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45;
const isDomainChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 45;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** Linear e-mail finder: expand around each `@`. */
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
/** `,` and `&` are word characters on purpose: values like `alpha,beta` and query strings `a=1&token=x` stay in one word. */
const DELIMS = new Set([...'"\'`;|<>()[]{}']);
const QUOTES = new Set(['"', "'", "`"]);
const isWs = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
const hasNewline = (s: string) => s.includes("\n") || s.includes("\r");

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
/** Skips one whitespace token unless it contains a line break (a value never starts on the next line). */
const skipWs = (toks: Tok[], i: number) => (i < toks.length && toks[i]!.t === "ws" && !hasNewline(toks[i]!.s) ? i + 1 : i);
const join = (toks: Tok[], from: number, to: number) => { let s = ""; for (let k = from; k < to; k++) s += toks[k]!.s; return s; };
function valueRun(toks: Tok[], start: number): number { let end = start; while (isValueTok(toks[end])) end++; return end; }
/**
 * End (exclusive) of the current value's line: the first whitespace token containing a line break, the closing quote of
 * the enclosing quoted context (`-H "Authorization: Bearer x" https://…` must keep the URL), or the end.
 */
function lineEnd(toks: Tok[], start: number, stopQuote: string | null): number {
  let j = start;
  while (j < toks.length) {
    const tk = toks[j]!;
    if (tk.t === "ws" && hasNewline(tk.s)) break;
    if (stopQuote !== null && tk.t === "punct" && tk.s === stopQuote && !escaped(toks, j)) break;
    j++;
  }
  return j;
}
function escaped(toks: Tok[], j: number): boolean {
  const prev = toks[j - 1];
  if (prev === undefined || prev.t !== "word") return false;
  let n = 0; for (let k = prev.s.length - 1; k >= 0 && prev.s[k] === "\\"; k--) n++;
  return n % 2 === 1;
}
function closingQuote(toks: Tok[], open: number): number {
  const q = toks[open]!.s;
  for (let j = open + 1; j < toks.length; j++) if (toks[j]!.t === "punct" && toks[j]!.s === q && !escaped(toks, j)) return j;
  return -1;
}

interface Consumed { text: string; next: number }
/** A quoted value at `start`: redacted to its closing quote (escape-aware; unterminated = to the end). */
function replaceQuoted(toks: Tok[], start: number, kind: string): Consumed | null {
  const tk = toks[start]!;
  const close = closingQuote(toks, start);
  const innerEnd = close === -1 ? toks.length : close;
  if (innerEnd === start + 1) return null;
  const inner = toks.slice(start + 1, innerEnd);
  if (inner.length === 1 && inner[0]!.t === "ph") return { text: join(toks, start, innerEnd) + (close === -1 ? "" : tk.s), next: close === -1 ? toks.length : close + 1 };
  return { text: `${tk.s}${PLACEHOLDER(kind)}${close === -1 ? "" : tk.s}`, next: close === -1 ? toks.length : close + 1 };
}
/** ONE value at `start`: a quoted span, or one run of words/placeholders (CLI argument, prose `Bearer x`). */
function replaceOne(toks: Tok[], start: number, kind: string): Consumed | null {
  const tk = toks[start];
  if (tk === undefined) return null;
  if (isQuote(tk)) return replaceQuoted(toks, start, kind);
  if (!isValueTok(tk)) return null;
  const end = valueRun(toks, start);
  if (end - start === 1 && tk.t === "ph") return { text: tk.s, next: end };
  return { text: PLACEHOLDER(kind), next: end };
}
/** The value of a sensitive assignment: a quoted span, or EVERYTHING to the end of the line (round 3: format-aware boundary). */
function replaceToLineEnd(toks: Tok[], start: number, kind: string, stopQuote: string | null): Consumed | null {
  const tk = toks[start];
  if (tk === undefined || tk.t === "ws") return null;
  if (isQuote(tk)) return tk.s === stopQuote ? null : replaceQuoted(toks, start, kind);
  const end = lineEnd(toks, start, stopQuote);
  if (end === start) return null;
  if (end - start === 1 && tk.t === "ph") return { text: tk.s, next: end };
  return { text: PLACEHOLDER(kind), next: end };
}

// ---------- token rules ----------

/**
 * Sensitive assignments: `NAME=VALUE`, `NAME:VALUE`, `NAME: VALUE`, `NAME = VALUE`, `"NAME": "VALUE"`, `--flag VALUE`.
 * Returns the replacement text and the index to continue from.
 */
/** ctx[k] = the quote character enclosing token k (null outside quotes), from one linear pass over unescaped quote tokens. */
function quoteContext(toks: Tok[]): (string | null)[] {
  const ctx: (string | null)[] = new Array(toks.length + 1);
  let open: string | null = null;
  for (let k = 0; k < toks.length; k++) {
    ctx[k] = open;
    const tk = toks[k]!;
    if (isQuote(tk) && !escaped(toks, k)) open = open === null ? tk.s : open === tk.s ? null : open;
  }
  ctx[toks.length] = open;
  return ctx;
}

function tryAssignment(toks: Tok[], i: number, ctx: (string | null)[]): Consumed | null {
  const tk = toks[i]!;
  const eq = tk.s.indexOf("="); const colon = tk.s.indexOf(":");
  const idx = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
  if (idx !== -1) {
    const name = tk.s.slice(0, idx); const rest = tk.s.slice(idx + 1);
    if (name.length === 0 || !isSecretKey(name)) return null;
    const head = tk.s.slice(0, idx + 1);
    if (rest.length > 0) {                                                     // value begins inside the word: it and the rest of the line go
      const end = lineEnd(toks, i + 1, ctx[i + 1] ?? null);
      if (end === i + 1 && PLACEHOLDER_FULL.test(rest)) return { text: head + rest, next: end };
      return { text: head + PLACEHOLDER("assignment"), next: end };
    }
    const vs = skipWs(toks, i + 1);
    const v = replaceToLineEnd(toks, vs, "assignment", ctx[vs] ?? null);
    return v ? { text: head + join(toks, i + 1, vs) + v.text, next: v.next } : null;
  }
  if (tk.s.startsWith("-")) {                                                  // CLI flag: the NEXT argument, even if it starts with `-`
    if (!flagIsSensitive(tk.s)) return null;
    const vs = skipWs(toks, i + 1);
    const v = replaceOne(toks, vs, "argv");
    return v ? { text: tk.s + join(toks, i + 1, vs) + v.text, next: v.next } : null;
  }
  if (!isSecretKey(tk.s)) return null;
  let j = i + 1;
  if (isQuote(toks[j])) j++;                                                   // `"password": ...` (closing quote of the name)
  j = skipWs(toks, j);
  const sep = toks[j];
  if (sep === undefined || sep.t !== "word" || !(sep.s.startsWith("=") || sep.s.startsWith(":"))) return null;
  const rest = sep.s.slice(1);
  const head = join(toks, i, j) + sep.s[0]!;
  if (rest.length > 0) {
    const end = lineEnd(toks, j + 1, ctx[j + 1] ?? null);
    if (end === j + 1 && PLACEHOLDER_FULL.test(rest)) return { text: head + rest, next: end };
    return { text: head + PLACEHOLDER("assignment"), next: end };
  }
  const vs = skipWs(toks, j + 1);
  const v = replaceToLineEnd(toks, vs, "assignment", ctx[vs] ?? null);
  return v ? { text: head + join(toks, j + 1, vs) + v.text, next: v.next } : null;
}

/** `Bearer xyz`, `basic dXNlcjpwYXNz` in prose (case-insensitive): the next value is the credential. */
function tryScheme(toks: Tok[], i: number): Consumed | null {
  const tk = toks[i]!;
  if (!isScheme(tk.s)) return null;
  const vs = skipWs(toks, i + 1);
  const v = replaceOne(toks, vs, tk.s.toLowerCase());
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
  if (word.length >= 8 && B64_RE.test(word) && word.length % 4 !== 1) {
    const buf = Buffer.from(word.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length >= 4 && printableRatio(buf) >= 0.9) candidates.push(buf.toString("utf8"));
  }
  if (word.length >= 8 && word.length % 2 === 0 && HEX_RE.test(word)) {
    const buf = Buffer.from(word, "hex");
    if (printableRatio(buf) >= 0.9) candidates.push(buf.toString("latin1"));
  }
  return candidates.some((c) => scanString(c, 0, true) !== c);
}

/** Query string handling: every `k=v` pair (split on `&`) with a sensitive `k` is redacted up to the next `&` or `#`. */
function redactQuery(w: string): string {
  const q = w.indexOf("?");
  if (q === -1) return w;
  const hash = w.indexOf("#", q);
  const query = w.slice(q + 1, hash === -1 ? undefined : hash);
  const pairs = query.split("&").map((p) => {
    const e = p.indexOf("=");
    if (e <= 0) return p;
    const k = p.slice(0, e); const v = p.slice(e + 1);
    if (v.length === 0 || PLACEHOLDER_FULL.test(v) || !isSecretKey(k)) return p;
    return `${k}=${PLACEHOLDER("assignment")}`;
  });
  return w.slice(0, q + 1) + pairs.join("&") + (hash === -1 ? "" : w.slice(hash));
}

function redactWord(word: string, decoded: boolean): string {
  if (word.length > WORD_MAX) return PLACEHOLDER("long-word");
  let w = word;
  if (w.includes("://")) w = w.replace(URL_CRED_RE, (_m, scheme: string) => `${scheme}${PLACEHOLDER("url-credentials")}@`);
  w = redactQuery(w);
  for (const p of WORD_PATTERNS) { p.re.lastIndex = 0; w = w.replace(p.re, PLACEHOLDER(p.kind)); }
  w = redactEmails(w);
  if (w === word && !decoded && decodedHasSecret(word)) return PLACEHOLDER("encoded");
  return w;
}

function scanTokens(toks: Tok[], decoded: boolean): string {
  let out = "";
  let i = 0;
  const ctx = quoteContext(toks);                                              // enclosing quoted context per token, for value boundaries
  while (i < toks.length) {
    const tk = toks[i]!;
    if (tk.t === "word") {
      const a = tryAssignment(toks, i, ctx) ?? tryScheme(toks, i);
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
  try { parsed = JSON.parse(s); } catch { return null; }
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
      if (x.startsWith("-")) { if (flagIsSensitive(x)) redactNext = 1; }      // ["--password", "-x"]; `--token=abc` carries its own value
      else if (isSecretKey(x)) redactNext = 1;                                 // ["Authorization", "..."], ["password", "..."]
    }
    out.push(redactValue(x, depth + 1, seen, decoded));
  }
  return out;
}

function redactObject(o: Record<string, unknown>, depth: number, seen: WeakSet<object>, decoded: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(o);
  const taken = new Set(keys);
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
    if (scanString(key, depth, decoded) !== key) {
      do { outKey = `[REDACTED:key#${++renamed}]`; } while (taken.has(outKey));
      taken.add(outKey);
    }
    let value: unknown;
    if (kw !== null) value = isProtected(o[key]) ? o[key] : PLACEHOLDER(`key:${kw}`);
    else if (key === pairValueKey) value = isProtected(o[key]) ? o[key] : PLACEHOLDER("pair");
    else value = redactValue(o[key], depth + 1, seen, decoded);
    Object.defineProperty(out, outKey, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function redactValue(v: unknown, depth: number, seen: WeakSet<object>, decoded: boolean): unknown {
  if (depth > MAX_DEPTH) throw new Error(`ledger.redact: nesting deeper than ${MAX_DEPTH}`);
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
