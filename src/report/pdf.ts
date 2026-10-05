/** Dependency-free PDF 1.4. Standard fonts only; ledger Unicode uses reversible UTF-16 escapes. */
export type PdfBlock = { kind: "heading" | "text" | "record"; lines: string[]; id?: string } |
  { kind: "table"; headers: string[]; rows: string[][]; caption?: string } |
  { kind: "pagebreak" } | { kind: "contents"; entries: { id: string; title: string; count: string }[] };
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
type Font = "F1" | "F2" | "F3";
// Standard Helvetica ASCII advance widths (1/1000 em). Bold uses a conservative extra allowance.
const advances = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
  667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const measure = (s: string, size: number, font: Font = "F1") => [...s].reduce((n, c) => n + (font === "F2" ? 600 : (advances[c.charCodeAt(0) - 32] ?? 1000) + (font === "F3" ? 70 : 0)), 0) * size / 1000;
// Whitespace stays attached to the preceding word, so concatenating runs preserves the original text.
// Long tokens get their own run; emit() fits them without splitting or discarding evidence.
const wrap = (s: string, width: number, size: number, font: Font = "F1"): string[] => {
  const lines: string[] = []; let line = "";
  for (const token of ascii(s).match(/\s+|\S+\s*/g) ?? []) {
    if (line && measure(line + token, size, font) > width) { lines.push(line); line = ""; }
    line += token;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
};

export function textPdf(blocks: PdfBlock[], chain: "PASS" | "FAIL"): Buffer {
  type Run = { text: string; size: number; font: Font; x: number; y: number; target?: string };
  type Page = { runs: Run[]; rules: string[] };
  const pages: Page[] = [{ runs: [], rules: [] }]; let used = 0;
  const capacity = 510, width = 712;
  const locations = new Map<string, number>();
  const next = () => { if (used) { pages.push({ runs: [], rules: [] }); used = 0; } };
  const emit = (text: string, size = 10, height = 14, font: Font = "F1", x = 40, available = width) => {
    if (used + height > capacity) next();
    const fitted = Math.min(size, available / Math.max(measure(text, 1, font), 1));
    pages.at(-1)!.runs.push({ text, size: fitted, font, x, y: 572 - used }); used += height;
  };
  const group = (lines: string[], size = 10, height = 14, font: Font = "F1", available = width) => {
    if (lines.length * height <= capacity && used + lines.length * height > capacity) next();
    lines.forEach(line => emit(line, size, height, font, 40, available));
  };
  for (const block of blocks) {
    if (block.kind === "pagebreak") { next(); continue; }
    if (block.kind === "contents") {
      emit("Contents", 24, 42, "F3");
      for (const entry of block.entries) {
        emit(ascii(entry.title), 13, 20, "F3");
        pages.at(-1)!.runs.push({ text: "", font: "F1", size: 12, x: 720, y: 572 - used + 20, target: entry.id });
        emit(ascii(entry.count), 10, 30);
      }
      continue;
    }
    if (block.kind === "heading") {
      const lines = block.lines.flatMap(s => wrap(s, width, 16, "F3"));
      if (used + lines.length * 24 + 50 > capacity) next();
      if (block.id) locations.set(block.id, pages.length);
      group(lines, 16, 24, "F3");
    } else if (block.kind !== "table") {
      const size = block.kind === "record" ? 9 : 10;
      const height = block.kind === "record" ? 12 : 14;
      const available = block.kind === "record" ? width : 520;
      const lines = block.lines.flatMap(s => {
        // IDs/hashes alone use Courier; prose and structured evidence use Helvetica.
        const font: Font = /^(?:record_id|call_id|agent_id|session_id|agent_session_id|parent_record_id|prev_hash|hash):/.test(s) ? "F2" : "F1";
        return wrap(s, available, size, font).map(text => ({ text, font }));
      });
      if (lines.length * height <= capacity && used + lines.length * height > capacity) next();
      lines.forEach(line => emit(line.text, size, height, line.font, 40, available));
      emit("", size, 8);
    } else {
      const size = 8, height = 11, padding = 6;
      const fonts: Font[] = block.headers.map(h => /(?:_id|_hash)$/.test(h) || h === "hash" ? "F2" : "F1");
      const desired = block.headers.map((h, i) => Math.max(62, Math.min(195, block.rows.reduce((maximum, r) => Math.max(maximum, measure(ascii(r[i] ?? ""), size, fonts[i])), measure(ascii(h), size, "F3")) + padding * 2)));
      const total = desired.reduce((a, b) => a + b, 0);
      const widths = desired.map(n => n * width / total);
      const rowLines = (row: string[], header = false) => row.map((s, i) => wrap(s, widths[i]! - padding * 2, size, header ? "F3" : fonts[i]));
      const headers = rowLines(block.headers, true);
      const headerHeight = Math.max(...headers.map(c => c.length)) * height + 10;
      const captionLines = block.caption ? wrap(block.caption, width, 9) : [];
      const topHeight = headerHeight + captionLines.length * 12;
      const drawRow = (cells: string[][], header = false, zebra = false, start = 0, count = Math.max(...cells.map(c => c.length))) => {
        const rowHeight = count * height + 10;
        const y = 579 - used;
        if (header || zebra) pages.at(-1)!.rules.push(`${header ? "0.91" : "0.97"} g 40 ${y - rowHeight} ${width} ${rowHeight} re f`);
        pages.at(-1)!.rules.push(`0.82 G 0.4 w 40 ${y - rowHeight} m 752 ${y - rowHeight} l S`);
        let x = 40;
        cells.forEach((cell, i) => {
          for (let j = 0; j < count; j++) {
            const text = cell[start + j] ?? "";
            const font = header ? "F3" : fonts[i]!;
            const fitted = Math.min(size, (widths[i]! - padding * 2) / Math.max(measure(text, 1, font), 1));
            pages.at(-1)!.runs.push({ text, size: fitted, font, x: x + padding, y: 570 - used - j * height });
          }
          x += widths[i]!;
        });
        used += rowHeight;
      };
      const header = () => { captionLines.forEach(line => emit(line, 9, 12)); drawRow(headers, true); };
      if (used + topHeight + 32 > capacity) next();
      header();
      for (const [index, row] of block.rows.entries()) {
        const cells = rowLines(row), count = Math.max(...cells.map(c => c.length));
        if (count * height + 10 <= capacity - topHeight && used + count * height + 10 > capacity) { next(); header(); }
        let start = 0;
        while (start < count) {
          const available = Math.floor((capacity - used - 10) / height);
          if (available < 1) { next(); header(); continue; }
          const take = Math.min(count - start, available);
          drawRow(cells, false, index % 2 === 1, start, take); start += take;
          if (start < count) { next(); header(); }
        }
      }
      emit("", 8, 12);
    }
  }
  for (const page of pages) for (const run of page.runs) if (run.target) run.text = String(locations.get(run.target) ?? "-");
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "",
    ...["Helvetica", "Courier", "Helvetica-Bold"].map(font => `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`)];
  const ids = pages.map((_, i) => 6 + i * 2);
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  for (const [i, page] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${ids[i]! + 1} 0 R >>`);
    const escape = (s: string) => s.replace(/[\\()]/g, "\\$&");
    const commands = page.runs.map(run => `/${run.font} ${run.size.toFixed(3).replace(/\.?0+$/, "")} Tf 1 0 0 1 ${run.x.toFixed(2)} ${run.y} Tm (${escape(run.text)}) Tj`);
    // Static octal middle dots; ledger text always passes through ascii() and escape().
    const footer = `Agent Ledger evidence pack \\267 page ${i + 1} / ${pages.length} \\267 chain ${chain}`;
    const stream = `${page.rules.join("\n")}\n0 g\nBT\n${commands.join("\n")}\n/F1 8 Tf 1 0 0 1 40 25 Tm (${footer}) Tj\nET\n`;
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
