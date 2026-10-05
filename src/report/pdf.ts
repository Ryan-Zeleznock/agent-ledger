/** Dependency-free PDF 1.4. Standard fonts only; ledger Unicode uses reversible UTF-16 escapes. */
export type PdfBlock = { kind: "heading" | "text" | "record"; lines: string[]; id?: string } |
  { kind: "table"; headers: string[]; rows: string[][]; caption?: string; exceptionRows?: boolean[]; approvalRows?: boolean[]; approvalColumn?: number } |
  { kind: "cover"; title: string; entity: string; scope: string; registration: string[][]; chain: string; anchor: string; head: string; trust: string; findings: number } |
  { kind: "pagebreak" } | { kind: "contents"; entries: { id: string; title: string; count: string }[] };
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
type Font = "F1" | "F2" | "F3" | "F4" | "F5";
// Standard Helvetica ASCII advance widths (1/1000 em). Serif and bold use conservative allowances.
// F1 Helvetica, F2 Courier, F3 Times-Bold, F4 Times-Roman, F5 Helvetica-Bold.
const advances = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
  667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const measure = (s: string, size: number, font: Font = "F1") => [...s].reduce((n, c) => n + (font === "F2" ? 600 : (advances[c.charCodeAt(0) - 32] ?? 1000) + (font === "F3" || font === "F5" ? 100 : font === "F4" ? 60 : 0)), 0) * size / 1000;
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
  type Run = { text: string; size: number; font: Font; x: number; y: number; target?: string; color?: string };
  type Page = { runs: Run[]; rules: string[] };
  const pages: Page[] = [{ runs: [], rules: [] }]; let used = 0;
  const capacity = 510, width = 712;
  const bronze = "0.5490 0.4157 0.1176", oxblood = "0.4784 0.1216 0.1686";
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
    if (block.kind === "cover") {
      const at = (value: string, x: number, available: number, font: Font, size: number, height: number) => {
        for (const line of wrap(value, available, size, font)) emit(line, size, height, font, x, available);
      };
      at(block.title, 40, 420, "F3", 30, 34);
      used += 12; at(block.entity, 40, 420, "F4", 13, 18);
      used += 12; at(block.scope, 40, 420, "F4", 11, 15);
      const left = used; used = 0;
      for (const [label, value] of block.registration) {
        at(label!, 520, 224, "F5", 8, 12);
        at(value!, 520, 224, label === "Pack" ? "F2" : "F1", 9, 12);
        pages.at(-1)!.rules.push(`0.78 G 0.5 w 520 ${579 - used - 1} m 752 ${579 - used - 1} l S`);
        used += 8;
      }
      used = Math.max(left, used) + 8;
      pages.at(-1)!.rules.push(`0.15 G 1.5 w 40 ${579 - used} m 752 ${579 - used} l S`);
      used += 24;
      const top = used, cy = 548 - top, cx = 88, r = 29, k = r * 0.552285;
      pages.at(-1)!.rules.push(`q ${bronze} RG 1.5 w ${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c S Q`);
      for (const [text, y] of [["CHAIN", cy + 4], [chain === "PASS" ? "VERIFIED" : "FAIL", cy - 9]] as const) {
        pages.at(-1)!.runs.push({ text, size: 8, font: "F5", x: cx - measure(text, 8, "F5") / 2, y, color: bronze });
      }
      at(block.chain, 144, 592, "F3", 12, 16);
      used += 4; at(block.anchor, 144, 592, "F4", 10, 14);
      used += 4; at("Ledger head (SHA-256)", 144, 592, "F5", 8, 12);
      at(block.head, 144, 592, "F2", 10, 14);
      used = Math.max(top + 68, used) + 8;
      pages.at(-1)!.rules.push(`0.62 G 0.75 w 40 ${579 - used} 712 ${used - top + 12} re S`);
      used += 20;
      at(`Findings: ${block.findings}`, 40, width, "F1", 10, 18);
      at("Trust boundary", 40, width, "F5", 9, 16);
      at(block.trust, 40, width, "F4", 11, 15);
      continue;
    }
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
        // IDs/hashes use Courier; prose uses Times, structured evidence uses Helvetica.
        const font: Font = /^(?:record_id|call_id|agent_id|session_id|agent_session_id|parent_record_id|prev_hash|hash|Observed ledger head):|^R-\d+/.test(s) ? "F2" : block.kind === "record" ? "F1" : "F4";
        return wrap(s, available, size, font).map(text => ({ text, font }));
      });
      if (lines.length * height <= capacity && used + lines.length * height > capacity) next();
      lines.forEach(line => emit(line.text, size, height, line.font, 40, available));
      emit("", size, 8);
    } else {
      const size = 8, height = 11, padding = 6;
      const fonts: Font[] = block.headers.map(h => /(?:_id|_hash)$/.test(h) || h === "hash" || h === "Chain" ? "F2" : "F1");
      const desired = block.headers.map((h, i) => Math.max(62, Math.min(195, block.rows.reduce((maximum, r) => Math.max(maximum, ...((r[i] ?? "").split("\n").map(line => measure(ascii(line), size, fonts[i])))), measure(ascii(h), size, "F5")) + padding * 2)));
      const total = desired.reduce((a, b) => a + b, 0);
      const widths = desired.map(n => n * width / total);
      const rowLines = (row: string[], header = false) => row.map((s, i) => s.split("\n").flatMap(line => wrap(line, widths[i]! - padding * 2, size, header ? "F5" : fonts[i])));
      const headers = rowLines(block.headers, true);
      const headerHeight = Math.max(...headers.map(c => c.length)) * height + 10;
      const captionLines = block.caption ? wrap(block.caption, width, 9) : [];
      const topHeight = headerHeight + captionLines.length * 12;
      const drawRow = (cells: string[][], header = false, exception = false, start = 0, count = Math.max(...cells.map(c => c.length)), approved = false) => {
        const rowHeight = count * height + 10;
        const y = 579 - used;
        if (exception) pages.at(-1)!.rules.push(`0.95 g 40 ${y - rowHeight + 0.5} ${width} ${rowHeight - 1} re f`);
        pages.at(-1)!.rules.push(`${header ? "0.15 G 1.5" : "0.78 G 0.5"} w 40 ${y - rowHeight} m 752 ${y - rowHeight} l S`);
        let x = 40;
        cells.forEach((cell, i) => {
          const human = approved && i === block.approvalColumn;
          if (human) pages.at(-1)!.rules.push(`q ${oxblood} RG 1 w ${x + 2} ${y - rowHeight + 2} ${widths[i]! - 4} ${rowHeight - 4} re S Q`);
          if (!header && block.headers[i] === "Chain") pages.at(-1)!.rules.push(`q 0.62 G [2 2] 0 d 0.5 w ${x + widths[i]!} ${y} m ${x + widths[i]!} ${y - rowHeight} l S Q`);
          for (let j = 0; j < count; j++) {
            const text = cell[start + j] ?? "";
            const font = header ? "F5" : fonts[i]!;
            const fitted = Math.min(size, (widths[i]! - padding * 2) / Math.max(measure(text, 1, font), 1));
            pages.at(-1)!.runs.push({ text, size: fitted, font, x: x + padding, y: 570 - used - j * height, ...(human ? { color: oxblood } : {}) });
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
          drawRow(cells, false, block.exceptionRows?.[index] ?? false, start, take, block.approvalRows?.[index] ?? false); start += take;
          if (start < count) { next(); header(); }
        }
      }
      emit("", 8, 12);
    }
  }
  for (const page of pages) for (const run of page.runs) if (run.target) run.text = String(locations.get(run.target) ?? "-");
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "",
    ...["Helvetica", "Courier", "Times-Bold", "Times-Roman", "Helvetica-Bold"].map(font => `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`)];
  const ids = pages.map((_, i) => 8 + i * 2);
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  for (const [i, page] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R /F5 7 0 R >> >> /Contents ${ids[i]! + 1} 0 R >>`);
    const escape = (s: string) => s.replace(/[\\()]/g, "\\$&");
    const commands = page.runs.map(run => `${run.color ? `${run.color} rg` : "0.12 g"} /${run.font} ${run.size.toFixed(3).replace(/\.?0+$/, "")} Tf 1 0 0 1 ${run.x.toFixed(2)} ${run.y} Tm (${escape(run.text)}) Tj`);
    // Static octal middle dots; ledger text always passes through ascii() and escape().
    const footer = `Agent Ledger evidence pack \\267 page ${i + 1} / ${pages.length} \\267 chain ${chain}`;
    const stream = `${page.rules.join("\n")}\n0 g\nBT\n${commands.join("\n")}\n0.12 g /F1 8 Tf 1 0 0 1 40 25 Tm (${footer}) Tj\nET\n`;
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
