/** Small, dependency-free PDF 1.4 text writer. Unicode is shown as reversible JS escapes. */
export function textPdf(lines: string[]): Buffer {
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const wrapped = lines.flatMap(line => ascii(line).match(/.{1,96}/g) ?? [""]);
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += 54) pages.push(wrapped.slice(i, i + 54));
  if (!pages.length) pages.push([]);
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"];
  const ids = pages.map((_, i) => 4 + i * 2);
  objects[1] = `<< /Type /Pages /Kids [${ids.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  for (const [i, page] of pages.entries()) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${ids[i]! + 1} 0 R >>`);
    const escape = (s: string) => s.replace(/[\\()]/g, "\\$&");
    const stream = `BT /F1 9 Tf 12 TL 40 750 Td\n${[...page, `Page ${i + 1} / ${pages.length}`].map(s => `(${escape(s)}) Tj T*`).join("\n")}\nET\n`;
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(result)); result += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  result += offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("");
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result, "ascii");
}
