// ADR-018 §3 (server audit P2-3): approvers see what they approve. The pipeline hands requestApproval the REDACTED stored
// projection (interface pin with Astra, 2026-10-05): fields the registry reviewed as clear (`storeArgs`) carry values;
// every other top-level field is `hmac-sha256:<64 hex>`; the ledger redactor may have left `[REDACTED:<kind>]`. This
// module renders only what it receives; it never sees raw arguments.
//
// Slack limits, verified 2026-10-05 against primary docs:
// - https://docs.slack.dev/reference/block-kit/blocks/section-block/ : section `text` "maximum length is 3000 characters".
// - https://docs.slack.dev/reference/block-kit/blocks/ : "You can include up to 50 blocks in each message".
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export const SLACK_SECTION_TEXT_MAX = 3_000;
export const SLACK_MESSAGE_MAX_BLOCKS = 50;
/** Blocks the card spends outside the argument list: header section, call context, digest context, actions. */
export const PREVIEW_FIXED_BLOCKS = 4;
/** Argument sections allowed; the rest of the 50-block budget is kept as margin. */
export const PREVIEW_MAX_ARG_BLOCKS = 40;
/** With `&<>` escaped (x5 worst case) a line stays under the 3000-character section limit: 128*5 + 400*5 + markers. */
export const PREVIEW_VALUE_MAX_CHARS = 400;
export const PREVIEW_KEY_MAX_CHARS = 128;
const HMAC_FULL = /^hmac-sha256:[0-9a-f]{64}$/;
const PLACEHOLDER_FULL = /^\[REDACTED:([a-z0-9][a-z0-9:#_-]*)\]$/;
const PLAIN_KEY = /^[A-Za-z0-9_.-]+$/;

export type ArgsPreview =
  | { ok: true; blocks: Record<string, unknown>[]; digest: string; fields: number; withheld: number; truncated: number }
  | { ok: false; reason: string; digest: string };

/** `sha256:<hex>` over the RFC 8785 (JCS) form of the arguments as received (the stored projection). */
export function argsDigest(args: unknown): string {
  let jcs: string | undefined;
  try { jcs = canonicalize(args ?? {}); } catch { jcs = undefined; }
  return `sha256:${createHash("sha256").update(jcs ?? "unserializable", "utf8").digest("hex")}`;
}

/** Control and format characters (newlines, bidi overrides, zero-width) become `\uXXXX`, so a value cannot fake a line or reorder text. */
function visible(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`);
}
/** Slack control characters, escaped as its formatting reference requires (also in plain_text, harmless if shown). */
function escapeSlack(text: string): string { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function clip(text: string, max: number): { text: string; cut: boolean } {
  const chars = [...text];
  if (chars.length <= max) return { text, cut: false };
  return { text: `${chars.slice(0, max).join("")} … [truncated: ${max} of ${chars.length} characters shown]`, cut: true };
}

/**
 * Renders every top-level field, sorted by name, one line each: a clear value as JSON (strings quoted, so its bounds are
 * visible), an hmac digest or a complete redaction placeholder as an explicit "withheld" marker. Values over
 * PREVIEW_VALUE_MAX_CHARS and names over PREVIEW_KEY_MAX_CHARS are cut WITH a stated truncation. Lines are packed into
 * plain_text sections (no mrkdwn: nothing in an argument can format, link or mention). If the lines need more than
 * PREVIEW_MAX_ARG_BLOCKS sections, the preview is refused (`ok: false`): the caller denies, never approves blind.
 */
export function buildArgsPreview(args: Record<string, unknown> | undefined): ArgsPreview {
  const digest = argsDigest(args);
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return { ok: false, reason: "arguments are not an object", digest };
  const keys = Object.keys(args ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let withheld = 0, truncated = 0;
  const lines: string[] = [];
  for (const key of keys) {
    const v = (args as Record<string, unknown>)[key];
    const k = clip(visible(PLAIN_KEY.test(key) ? key : JSON.stringify(key)), PREVIEW_KEY_MAX_CHARS);
    if (k.cut) truncated++;
    let shown: string;
    if (typeof v === "string" && HMAC_FULL.test(v)) { withheld++; shown = "[withheld: stored as a keyed digest (hmac-sha256); not reviewed as clear]"; }
    else if (typeof v === "string" && PLACEHOLDER_FULL.test(v)) { withheld++; shown = `[withheld: redacted by the ledger (${PLACEHOLDER_FULL.exec(v)![1]})]`; }
    else {
      let json: string;
      try { json = JSON.stringify(v) ?? String(v); } catch { json = "[unrenderable value]"; }
      const c = clip(visible(json), PREVIEW_VALUE_MAX_CHARS);
      if (c.cut) truncated++;
      shown = c.text;
    }
    const line = escapeSlack(`• ${k.text}: ${shown}`);
    if (line.length > SLACK_SECTION_TEXT_MAX) return { ok: false, digest, reason: "approval preview does not fit Slack's limits (one field line exceeds a section)" };
    lines.push(line);
  }
  if (lines.length === 0) lines.push("(no arguments)");
  const sections: string[] = [];
  let current = "";
  for (const line of lines) {
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length <= SLACK_SECTION_TEXT_MAX) { current = next; continue; }
    sections.push(current); current = line; // a single line is checked above to fit one section
  }
  if (current.length > 0) sections.push(current);
  if (sections.length > PREVIEW_MAX_ARG_BLOCKS) {
    return { ok: false, digest, reason: `approval preview does not fit Slack's limits (${keys.length} fields need ${sections.length} sections; at most ${PREVIEW_MAX_ARG_BLOCKS})` };
  }
  const blocks: Record<string, unknown>[] = sections.map((text) => ({ type: "section", text: { type: "plain_text", text, emoji: false } }));
  return { ok: true, blocks, digest, fields: keys.length, withheld, truncated };
}

/** The context line under the argument list: counts, the digest and what "withheld" means. */
export function previewSummary(p: Extract<ArgsPreview, { ok: true }>): string {
  return `${p.fields} field${p.fields === 1 ? "" : "s"} shown in full or marked; ${p.withheld} withheld; ${p.truncated === 0 ? "nothing truncated" : `${p.truncated} truncated (marked)`}. ` +
    `Arguments digest ${p.digest} (JCS of the stored arguments). Withheld fields are stored as keyed digests; to show one here, review it as clear (storeArgs).`;
}
