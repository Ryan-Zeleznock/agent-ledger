import { expect, it } from "vitest";
import { textPdf } from "../src/report/pdf.js";

const printedLines = (pdf: string) => [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map(m => m[1]!.replace(/\\([\\()])/g, "$1"));
function assertStructure(pdf: Buffer) {
  const text = pdf.toString("ascii");
  const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
  expect(text.slice(xref, xref + 4)).toBe("xref");
  const entries = [...text.matchAll(/^(\d{10}) 00000 n \n/gm)];
  entries.forEach((m, i) => expect(text.slice(Number(m[1]))).toMatch(new RegExp(`^${i + 1} 0 obj\\n`)));
  expect(Number(/xref\n0 (\d+)/.exec(text)![1])).toBe(entries.length + 1);
  for (const m of text.matchAll(/\/Length (\d+) >>\nstream\n([\s\S]*?)endstream/g)) expect(Buffer.byteLength(m[2]!)).toBe(Number(m[1]));
  const count = Number(/\/Count (\d+)/.exec(text)![1]);
  expect([...text.matchAll(/\/Type \/Page\b/g)]).toHaveLength(count);
  expect(/\/Kids \[([^\]]+)\]/.exec(text)![1]!.match(/\d+ 0 R/g)).toHaveLength(count);
}
it.each(["text", "heading", "table"] as const)("review #5: Unicode escapes remain whole at %s wrapping boundaries", kind => {
  const input = `${"x".repeat(kind === "heading" ? 82 : 146)}é🙂${"y".repeat(147)}é`;
  const block = kind === "table" ? { kind, headers: ["value"], rows: [[input]] } : { kind, lines: [input] };
  const lines = printedLines(textPdf([block], "PASS").toString("ascii")).map(line => line.trimEnd());
  for (const line of lines) expect(line).not.toMatch(/\\(?:u[0-9a-f]{0,3})?$/);
  const evidence = lines.filter(s => !s.startsWith("Agent Ledger") && s !== "value" && s !== "").join("");
  expect(evidence).toBe(input.replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
});
it("review #6: fitting record blocks stay on one page and the PDF has valid offsets, lengths and page references", () => {
  const pdf = textPdf(Array.from({ length: 12 }, (_, i) => ({ kind: "record" as const, lines: [`record_id: ${i}`, ...Array.from({ length: 19 }, () => "é (\\)"), `received_at: ${i}`] })), "PASS");
  assertStructure(pdf);
  for (const page of pdf.toString("ascii").matchAll(/stream\n([\s\S]*?)endstream/g)) {
    const lines = printedLines(page[1]!);
    expect(lines.filter(s => s.startsWith("record_id:")).map(s => s.slice(11))).toEqual(lines.filter(s => s.startsWith("received_at:")).map(s => s.slice(13)));
  }
  // The validation itself must reject a broken cross-reference, not merely parse today's output.
  const corrupt = Buffer.from(pdf.toString("ascii").replace(/startxref\n\d+/, "startxref\n0"));
  expect(() => assertStructure(corrupt)).toThrow();
});
it("review #6 repro: the old presence-only assertion accepts a split record", () => {
  const page = "record_id: 1\nreceived_at: 1\nrecord_id: 2";
  expect(page).toContain("received_at:");
  expect((page.match(/record_id:/g) ?? []).length).not.toBe((page.match(/received_at:/g) ?? []).length);
});
