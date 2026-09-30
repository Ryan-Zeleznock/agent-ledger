/**
 * Redaction of tool arguments before hashing and storage (spec §9). Two layers, applied to every nesting level of
 * objects and arrays:
 *  1. KEY layer: a field whose (normalised) name says "secret" has its WHOLE value replaced, whatever the type.
 *  2. VALUE layer: every string is scanned for known secret and PII shapes; only the matching span is replaced,
 *     so the surrounding evidence (the command, the URL host) survives.
 * The placeholder is `[REDACTED:<kind>]`; a placeholder is never re-matched, so redaction is idempotent.
 * Over-redaction is the accepted failure mode: a lost `tokens: 42` costs less than a stored credential.
 * Inputs are JSON data (they arrive over MCP or hook JSON); the function never mutates them.
 */

const PLACEHOLDER = (kind: string) => `[REDACTED:${kind}]`;

/** Normalised key (lowercase, separators removed) ENDS WITH one of these → the value is a secret. */
const KEY_SUFFIXES = [
  "password", "passwd", "passphrase", "secret", "token", "apikey", "privatekey", "accesskey", "secretkey",
  "clientsecret", "authorization", "credential", "credentials", "cookie", "setcookie",
] as const;
/** Normalised key EQUALS one of these → the value is a secret. Exact, so `sort_key` and `author` stay. */
const KEY_EXACT = ["pwd", "pass", "auth", "bearer", "key", "ssn", "otp", "pin"] as const;

const normaliseKey = (key: string) => key.toLowerCase().replace(/[-_.\s]/g, "");
export function isSecretKey(key: string): boolean {
  const k = normaliseKey(key);
  return KEY_EXACT.includes(k as (typeof KEY_EXACT)[number]) || KEY_SUFFIXES.some((s) => k.endsWith(s));
}

interface ValuePattern { kind: string; re: RegExp; replace?: (m: RegExpExecArray) => string }
/**
 * Ordered: structural shapes (PEM, URL credentials, auth headers) first, then vendor token shapes, then generic
 * `name=value` assignments (which skip values that are already placeholders), then PII.
 */
export const VALUE_PATTERNS: readonly ValuePattern[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "url-credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, replace: (m) => `${m[1]}${PLACEHOLDER("url-credentials")}@` },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { kind: "basic-auth", re: /\bBasic\s+[A-Za-z0-9+/]{8,}=*/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|ANPA|ANVA|APKA|ASCA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "stripe-key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
  { kind: "sk-token", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bxapp-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    kind: "assignment",
    // `DB_PASSWORD=...`, `token: ...`, `"api_key": "..."`, `?access_token=...`; the value may be quoted.
    re: /([A-Za-z0-9_.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(["']?)(?!\[REDACTED:)([^\s"',;&|]+)\3/gi,
    replace: (m) => `${m[1]}${m[2]}${m[3]}${PLACEHOLDER("assignment")}${m[3]}`,
  },
  { kind: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "card-number", re: /\b(?:\d[ -]?){12,18}\d\b/g, replace: (m) => (luhnValid(m[0]) ? PLACEHOLDER("card-number") : m[0]) },
];

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

export function redactString(s: string): string {
  let out = s;
  for (const p of VALUE_PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray; // [match, ...groups]
      return p.replace ? p.replace(m) : PLACEHOLDER(p.kind);
    });
  }
  return out;
}

function redactValue(v: unknown, seen: WeakSet<object>): unknown {
  if (typeof v === "string") return redactString(v);
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v)) throw new Error("ledger.redact: circular reference in args");
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => redactValue(x, seen));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      const value = isSecretKey(key) ? PLACEHOLDER(`key:${key}`) : redactValue((v as Record<string, unknown>)[key], seen);
      // defineProperty, not assignment: a JSON key named `__proto__` must become data, never the prototype.
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactValue(args, new WeakSet()) as Record<string, unknown>;
}
