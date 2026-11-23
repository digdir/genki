import { codePointLength, codePointSlice, conversionText } from '@genai/port-knowledge';
import { describe, expect, it } from 'vitest';
import { doc, type Place } from './docling-document.test-utils.js';
import { doclingParts } from './docling-parts.js';
import { partsUnitChunks } from './parts-unit.js';

const unitsOf = (document: ReturnType<typeof doc>) => doclingParts(document).units;

const across = (page: number, pieces: string[]): Place[] => {
  let at = 0;
  return pieces.map((piece, i) => {
    const charspan: [number, number] = [at, at + codePointLength(piece)];
    at = charspan[1] + 1;
    return { page: page + i, top: i === 0 ? 700 : 60, charspan };
  });
};

describe('parts-unit', () => {
  it('furniture never reaches a chunk', () => {
    const units = unitsOf(
      doc(2, (add) => {
        add.text('page_header', 'Årsrapport 2025 for Digdir', 1, { layer: 'furniture', top: 20 });
        add.text('text', 'Innholdet på side én.', 1);
        add.text('page_footer', 'Side 1 av 2', 1, { layer: 'furniture', top: 780 });
        add.text('page_header', 'Årsrapport 2025 for Digdir', 2, { layer: 'furniture', top: 20 });
        add.text('text', 'Innholdet på side to.', 2);
      }),
    );
    const chunks = partsUnitChunks(units, { splitMaxLength: 4000 });
    expect(chunks.map((c) => c.text)).toEqual(['Innholdet på side én.', 'Innholdet på side to.']);
  });

  it("a chunk's text is its span of the conversion's text", () => {
    const units = unitsOf(
      doc(2, (add) => {
        add.text('section_header', 'Innledning', 1);
        add.text('text', 'Et avsnitt med 𝔘𝔫𝔦𝔠𝔬𝔡𝔢 utenfor BMP.', 1);
        add.text('text', 'Neste side.', 2);
      }),
    );
    const text = conversionText(units.flatMap((u) => u.parts));
    const chunks = partsUnitChunks(units, { splitMaxLength: 4000 });
    expect(chunks.length).toBe(2);
    for (const chunk of chunks)
      expect(codePointSlice(text, chunk.textStart, chunk.textEnd)).toBe(chunk.text);
  });

  it('a chunk from parts-unit covers one page of a PDF, as the page recipe does', () => {
    const units = unitsOf(
      doc(4, (add) => {
        add.text('text', 'Side én, første avsnitt.', 1);
        add.text('text', 'Side én, andre avsnitt.', 1);
        add.text('text', 'Side to.', 2);
        add.picture(3);
        add.text('text', 'Side fire.', 4);
      }),
    );
    const chunks = partsUnitChunks(units, { splitMaxLength: 4000 });
    expect(chunks.map((c) => [c.pageFrom, c.pageTo])).toEqual([
      [1, 1],
      [2, 2],
      [4, 4],
    ]);
    expect(chunks[0]?.text).toBe('Side én, første avsnitt.\n\nSide én, andre avsnitt.');
  });

  it('a paragraph across a page break is in one chunk, with both pages', () => {
    const pieces = ['Avsnittet starter nederst på side én', 'og slutter øverst på side to.'];
    const units = unitsOf(
      doc(2, (add) => {
        add.text('text', pieces.join(' '), 1, { places: across(1, pieces) });
        add.text('text', 'Resten av side to.', 2);
      }),
    );
    const chunks = partsUnitChunks(units, { splitMaxLength: 4000 });
    expect(chunks[0]).toMatchObject({ text: pieces.join(' '), pageFrom: 1, pageTo: 2 });
    expect(chunks[1]).toMatchObject({ text: 'Resten av side to.', pageFrom: 2, pageTo: 2 });
  });

  it('a part over the size limit is a chunk of its own and is not dropped', () => {
    const long = 'x'.repeat(60);
    const units = unitsOf(
      doc(1, (add) => {
        add.text('text', 'Kort.', 1);
        add.text('text', long, 1);
        add.text('text', 'Også kort.', 1);
      }),
    );
    const chunks = partsUnitChunks(units, { splitMaxLength: 20 });
    expect(chunks.map((c) => c.text)).toEqual(['Kort.', long, 'Også kort.']);
    expect(chunks.map((c) => [c.seqFrom, c.seqTo])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('a page over the size limit is split on part boundaries', () => {
    const units = unitsOf(
      doc(1, (add) => {
        add.text('text', 'Første.', 1);
        add.text('text', 'Andre.', 1);
        add.text('text', 'Tredje.', 1);
      }),
    );
    const chunks = partsUnitChunks(units, { splitMaxLength: 16 });
    expect(chunks.map((c) => c.text)).toEqual(['Første.\n\nAndre.', 'Tredje.']);
  });
});
