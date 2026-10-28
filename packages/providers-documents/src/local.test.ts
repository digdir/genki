import { describe, expect, it } from 'vitest';
import {
  DocumentTooLargeError,
  NoTextLayerError,
  markerPageSeparator,
  readDocument,
} from '@genai/ingest';
import { docxBytes } from '@genai/port-blob';
import { TooManyPagesError, UnsupportedDocumentError, createLocalConverter } from './index.js';

const encoder = new TextEncoder();

const pdfBytes = (pages: string[][]) => {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) + 1;
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  const pagesId = 2 + pages.length * 2 + 1;
  for (const lines of pages) {
    const ops = lines.length
      ? `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`
      : '0 0 m 200 200 l S';
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  add(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
  );
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

describe('local document converter', () => {
  const converter = createLocalConverter();

  it('reads the text layer of a PDF and keeps page boundaries like Marker', async () => {
    const markdown = await converter.toMarkdown({
      name: 'arsrapport.pdf',
      bytes: pdfBytes([
        ['Arsrapport 2025', 'Direktoratet leverte alle mal.'],
        ['Side to handler om budsjett.'],
      ]),
    });

    const pages = markdown.split(markerPageSeparator);
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain('Arsrapport 2025');
    expect(pages[0]).toContain('Direktoratet leverte alle mal.');
    expect(pages[1]).toBe('Side to handler om budsjett.');
  });

  it('a PDF without a text layer throws NoTextLayerError', async () => {
    await expect(
      converter.toMarkdown({ name: 'skannet.pdf', bytes: pdfBytes([[], []]) }),
    ).rejects.toBeInstanceOf(NoTextLayerError);
  });

  it('a PDF without a text layer becomes a no_text skip during ingestion', async () => {
    expect(
      await readDocument({ name: 'skannet.pdf', bytes: pdfBytes([[]]) }, { converter }),
    ).toEqual({ skip: 'no_text' });
    expect(
      await readDocument(
        { name: 'ødelagt.pdf', bytes: encoder.encode('ikke en pdf') },
        { converter },
      ),
    ).toEqual({ skip: 'conversion_failed' });
  });

  it('converts DOCX paragraphs to markdown', async () => {
    const markdown = await converter.toMarkdown({
      name: 'brev.docx',
      bytes: docxBytes(['Tildelingsbrev 2025', 'Departementet stiller midler til disposisjon.']),
    });

    expect(markdown).toBe('Tildelingsbrev 2025\n\nDepartementet stiller midler til disposisjon.');
  });

  it('passes text through and cleans HTML', async () => {
    expect(
      await converter.toMarkdown({ name: 'notat.md', bytes: encoder.encode('# Notat\n\nTekst') }),
    ).toBe('# Notat\n\nTekst');
    expect(
      await converter.toMarkdown({
        name: 'side',
        mimetype: 'text/html; charset=utf-8',
        bytes: encoder.encode('<nav>Meny</nav><main><h1>Side</h1><p>Innhold</p></main>'),
      }),
    ).toBe('# Side\n\nInnhold');
  });

  it('refuses files above the size limit and types it does not read', async () => {
    const small = createLocalConverter({ maxBytes: 10 });

    await expect(
      small.toMarkdown({ name: 'stor.pdf', bytes: new Uint8Array(11) }),
    ).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(
      converter.toMarkdown({ name: 'budsjett.xlsx', bytes: new Uint8Array(1) }),
    ).rejects.toBeInstanceOf(UnsupportedDocumentError);
  });

  it('refuses a Word file whose zip entries declare more than the unzipped size limit', async () => {
    const bytes = docxBytes(['x'.repeat(5000)]);
    await expect(
      createLocalConverter({ maxUnzippedBytes: 4000 }).toMarkdown({ name: 'stor.docx', bytes }),
    ).rejects.toBeInstanceOf(DocumentTooLargeError);
    await expect(
      createLocalConverter({ maxUnzippedBytes: 100_000 }).toMarkdown({ name: 'liten.docx', bytes }),
    ).resolves.toContain('xxx');
  });

  it('refuses a PDF with more pages than the page limit', async () => {
    const bytes = pdfBytes([['En'], ['To'], ['Tre']]);
    await expect(
      createLocalConverter({ maxPages: 2 }).toMarkdown({ name: 'lang.pdf', bytes }),
    ).rejects.toBeInstanceOf(TooManyPagesError);
    await expect(
      createLocalConverter({ maxPages: 3 }).toMarkdown({ name: 'kort.pdf', bytes }),
    ).resolves.toContain('Tre');
  });
});
