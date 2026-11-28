import { describe, expect, it } from 'vitest';
import { readPdfLayout } from './index.js';

const encoder = new TextEncoder();

interface Line {
  text: string;
  size: number;
  /** Points from the page's bottom edge. */
  y: number;
  bold?: boolean;
  /** Sets the size with the text matrix and the font at size 1, as many PDFs do. */
  matrix?: boolean;
  /** Set turned a quarter left, running up the page, as a table's side label is. */
  turned?: boolean;
}

interface Bookmark {
  title: string;
  /** The page from 1, or a link with no page. */
  page: number | 'link';
  children?: Bookmark[];
}

/** A PDF with lines of text on 612 x 792 pages and an outline of bookmarks, each page turned by `rotate`. */
const pdfWith = (pages: Line[][], bookmarks: Bookmark[], rotate = 0) => {
  const objects: string[] = [''];
  const add = (body = '') => objects.push(body);
  const set = (id: number, body: string) => {
    objects[id - 1] = body;
  };
  const regular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const pagesId = add();
  const pageIds = pages.map((lines) => {
    const ops = lines
      .map((l) => {
        const font = l.bold ? '/F2' : '/F1';
        if (l.turned)
          return `BT ${font} 1 Tf 0 ${l.size} ${-l.size} 0 72 ${l.y} Tm (${l.text}) Tj ET`;
        return l.matrix
          ? `BT ${font} 1 Tf ${l.size} 0 0 ${l.size} 72 ${l.y} Tm (${l.text}) Tj ET`
          : `BT ${font} ${l.size} Tf 72 ${l.y} Td (${l.text}) Tj ET`;
      })
      .join('\n');
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Rotate ${rotate} /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`,
    );
  });
  set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
  const outlinesId = add();
  const items = (marks: Bookmark[], parent: number): number[] => {
    const ids = marks.map(() => add());
    marks.forEach((mark, i) => {
      const kids = items(mark.children ?? [], ids[i] as number);
      const target =
        mark.page === 'link'
          ? '/A << /S /URI /URI (https://example.org) >>'
          : `/Dest [${pageIds[mark.page - 1]} 0 R /XYZ 0 792 0]`;
      set(
        ids[i] as number,
        `<< /Title (${mark.title}) /Parent ${parent} 0 R ${target}` +
          (i > 0 ? ` /Prev ${ids[i - 1]} 0 R` : '') +
          (i < ids.length - 1 ? ` /Next ${ids[i + 1]} 0 R` : '') +
          (kids.length
            ? ` /First ${kids[0]} 0 R /Last ${kids.at(-1)} 0 R /Count ${kids.length}`
            : '') +
          ' >>',
      );
    });
    return ids;
  };
  const top = items(bookmarks, outlinesId);
  set(
    outlinesId,
    `<< /Type /Outlines /First ${top[0]} 0 R /Last ${top.at(-1)} 0 R /Count ${top.length} >>`,
  );
  set(1, `<< /Type /Catalog /Pages ${pagesId} 0 R /Outlines ${outlinesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(out);
};

describe('PDF layout', () => {
  const bytes = pdfWith(
    [
      [
        { text: 'Tildeling', size: 18, y: 700, bold: true },
        { text: 'Kapitlet handler om tildeling.', size: 11, y: 660 },
      ],
      [{ text: 'Soknad', size: 14, y: 700, matrix: true }],
    ],
    [
      { title: 'Tildeling', page: 1, children: [{ title: 'Soknad', page: 2 }] },
      { title: 'Nettside', page: 'link' },
    ],
  );

  it("reads the outline with each entry's depth and page, and no page for an entry that has no page destination", async () => {
    const { outline } = await readPdfLayout(bytes);
    expect(outline).toEqual([
      { title: 'Tildeling', level: 1, page: 1 },
      { title: 'Soknad', level: 2, page: 2 },
      { title: 'Nettside', level: 1, page: null },
    ]);
  });

  it("reads each run's size, also when the text matrix sets it, and its box as fractions from the page's top left", async () => {
    const { runs } = await readPdfLayout(bytes);
    expect(runs.map(({ page, size, bold, chars }) => ({ page, size, bold, chars }))).toEqual([
      { page: 1, size: 18, bold: true, chars: 9 },
      { page: 1, size: 11, bold: false, chars: 27 },
      { page: 2, size: 14, bold: false, chars: 6 },
    ]);
    const [x0, y0, , y1] = runs[0]?.box ?? [];
    expect(x0).toBeCloseTo(72 / 612);
    expect(y1).toBeCloseTo((792 - 700) / 792);
    expect(y0).toBeLessThan(y1 as number);
  });

  it('a turned page gives boxes as the page is shown, as Docling gives them', async () => {
    const turned = pdfWith(
      [[{ text: 'Tabell', size: 12, y: 700 }]],
      [{ title: 'Tabell', page: 1 }],
      90,
    );
    const { runs } = await readPdfLayout(turned);
    // Turned 90° clockwise, the page is 792 wide and 612 high: the line 700 up from the bottom is
    // 700 from the left, and its start 72 from the left is 72 from the top.
    const [x0, y0, x1, y1] = runs[0]?.box ?? [];
    expect(x0).toBeCloseTo(700 / 792, 2);
    expect(x1).toBeCloseTo((700 + 12) / 792, 2);
    expect(y0).toBeCloseTo(72 / 612, 2);
    expect(y1).toBeGreaterThan(y0 as number);
  });

  it('a run set turned on an upright page is boxed along its own direction', async () => {
    const side = pdfWith(
      [[{ text: 'Sidetittel', size: 12, y: 300, turned: true }]],
      [{ title: 'Sidetittel', page: 1 }],
    );
    const [x0, y0, x1, y1] = (await readPdfLayout(side)).runs[0]?.box ?? [];
    // Running up from (72, 300): its height reaches left of x 72, its length up from y 300.
    expect(x1).toBeCloseTo(72 / 612, 2);
    expect(x0).toBeCloseTo((72 - 12) / 612, 2);
    expect(y1).toBeCloseTo((792 - 300) / 792, 2);
    expect(((y1 as number) - (y0 as number)) * 792).toBeGreaterThan(
      ((x1 as number) - (x0 as number)) * 612,
    );
  });

  it('a PDF over the page limit gives no layout', async () => {
    await expect(readPdfLayout(bytes, { maxPages: 1 })).rejects.toMatchObject({
      name: 'TooManyPagesError',
    });
  });

  it('a PDF over the size limit gives no layout', async () => {
    await expect(readPdfLayout(bytes, { maxBytes: 100 })).rejects.toMatchObject({
      name: 'DocumentTooLargeError',
    });
  });

  it('a file pdf.js cannot open fails', async () => {
    await expect(readPdfLayout(encoder.encode('ikke en pdf'))).rejects.toThrow();
  });
});
