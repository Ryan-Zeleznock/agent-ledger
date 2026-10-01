/** Dependency-free Courier PDF. Ledger Unicode remains reversible; the static footer uses WinAnsi middle dots. */
export type PdfBlock = { kind: "heading" | "text" | "record"; lines: string[] } |
  { kind: "table"; headers: string[]; rows: string[][] };
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const wrap = (s: string, width: number): string[] => ascii(s).match(new RegExp(`.{1,${width}}`, "g")) ?? [""];

export function textPdf(blocks: PdfBlock[], chain: "PASS" | "FAIL"): Buffer {
  type Line = { text: string; size: number; height: number };
  const pages: Line[][] = [[]]; let used = 0;
  const capacity = 510;
  const next = () => { pages.push([]); used = 0; };
  const emit = (text: string, size = 8, height = 10) => {
    if (used + height > capacity) next();
    pages.at(-1)!.push({ text, size, height }); used += height;
  };
  const group = (lines: string[], size = 8, height = 10) => {
    if (lines.length * height <= capacity && used + lines.length * height > capacity) next();
    lines.forEach(line => emit(line, size, height));
  };
  for (const block of blocks) {
    if (block.kind === "heading") {
      const lines = block.lines.flatMap(s => wrap(s, 84));
      if (used + lines.length * 20 + 40 > capacity) next();
      group(lines, 14, 20);
    } else if (block.kind !== "table") {
      group(block.lines.flatMap(s => wrap(s, 148)));
      emit("");
    } else {
      const width = Math.floor((148 - (block.headers.length - 1) * 3) / block.headers.length);
      const rowLines = (row: string[]) => {
        const cells = row.map(s => wrap(s, width));
        return Array.from({ length: Math.max(...cells.map(c => c.length)) }, (_, i) => cells.map(c => (c[i] ?? "").padEnd(width)).join(" | "));
      };
      const headers = rowLines(block.headers);
      const headerHeight = headers.length * 10;
      const header = () => headers.forEach(s => emit(s));
      if (used + headerHeight + 20 > capacity) next();
      header();
      for (const row of block.rows) {
        const lines = rowLines(row);
        if (lines.length * 10 + headerHeight <= capacity && used + lines.length * 10 > capacity) { next(); header(); }
        for (const line of lines) {
          if (used + 10 > capacity) { next(); header(); }
          emit(line);
        }
      }
      emit("");
    }
  }
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"];
  const ids = pages.map((_, i) => 4 + i * 2);
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  for (const [i, page] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 3 0 R >> >> /Contents ${ids[i]! + 1} 0 R >>`);
    const escape = (s: string) => s.replace(/[\\()]/g, "\\$&");
    let y = 572;
    const commands = page.map(line => { const cmd = `/F1 ${line.size} Tf 1 0 0 1 40 ${y} Tm (${escape(line.text)}) Tj`; y -= line.height; return cmd; });
    // Static text only: octal 267 is the WinAnsi middle dot; no ledger text bypasses escape().
    const footer = `Agent Ledger evidence pack \\267 page ${i + 1} / ${pages.length} \\267 chain ${chain}`;
    const stream = `BT\n${commands.join("\n")}\n/F1 8 Tf 1 0 0 1 40 25 Tm (${footer}) Tj\nET\n`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let result = "%PDF-1.4\n"; const offsets = [0];
  for (const [i, obj] of objects.entries()) { offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${obj}\nendobj\n`; }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result, "ascii");
}
