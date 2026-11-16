const encoder = new TextEncoder();

/**
 * A PDF with one text page per entry; the pages in `broken` (counted from 1) carry a stray `)` in
 * their dictionary, which pdf.js reads as `Illegal character: 41`, as some KUDOS files do.
 */
export const pdfWithBrokenPages = (texts: string[], broken: number[]) => {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) + 1;
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = 2 + texts.length * 2 + 1;
  const ids: number[] = [];
  texts.forEach((text, i) => {
    const ops = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    const bad = broken.includes(i + 1) ? ' )' : '';
    ids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R${bad} /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  });
  add(`<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(' ')}] /Count ${ids.length} >>`);
  const all = [`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, ...objects];
  let out = '%PDF-1.4\n';
  const offsets = all.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${all.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
};
