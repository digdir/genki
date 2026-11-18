import { codePointLength, codePointSlice, conversionText } from '@genai/port-knowledge';
import { describe, expect, it } from 'vitest';
import { doc, type Place } from './docling-document.test-utils.js';
import { doclingParts } from './docling-parts.js';

const partsOf = (document: ReturnType<typeof doc>) =>
  doclingParts(document).units.flatMap((unit) => unit.parts);

/** Boxes on consecutive pages from `page`, each holding the next piece of a text whose pieces are joined by a space. */
const across = (page: number, pieces: string[]): Place[] => {
  let at = 0;
  return pieces.map((piece, i) => {
    const charspan: [number, number] = [at, at + codePointLength(piece)];
    at = charspan[1] + 1;
    return { page: page + i, top: i === 0 ? 700 : 60, charspan };
  });
};

describe('docling-parts', () => {
  it('a paragraph across a page break is one part with a region on each page', () => {
    const pieces = ['Avsnittet starter nederst på side én', 'og slutter øverst på side to.'];
    const parts = partsOf(
      doc(2, (add) => add.text('text', pieces.join(' '), 1, { places: across(1, pieces) })),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]?.regions.map((region) => region.unit)).toEqual([1, 2]);
  });

  it("a paragraph on five pages is stored in its first page's row, whose unit_to is the fifth", () => {
    const pieces = ['Første', 'andre', 'tredje', 'fjerde', 'femte side.'];
    const { units } = doclingParts(
      doc(5, (add) => add.text('text', pieces.join(' '), 1, { places: across(1, pieces) })),
    );
    expect(units[0]?.parts.map((part) => part.seq)).toEqual([0]);
    expect(units[0]?.unitTo).toBe(5);
    expect(units.slice(1).map((unit) => unit.parts)).toEqual([[], [], [], []]);
  });

  it('a unit where no part starts has an empty row', () => {
    const { units } = doclingParts(
      doc(3, (add) => {
        add.text('text', 'Side én.', 1);
        add.text('text', 'Side tre.', 3);
      }),
    );
    expect(units[1]).toEqual({
      unit: 2,
      kind: 'page',
      label: null,
      width: 600,
      height: 800,
      textStart: null,
      textEnd: null,
      unitTo: 2,
      seqFrom: 1,
      seqTo: 0,
      parts: [],
    });
  });

  it("a part that starts on an earlier page than the part before it is stored in that part's row", () => {
    const { units } = doclingParts(
      doc(2, (add) => {
        add.text('text', 'Lest først, står på side to.', 2);
        add.text('text', 'Lest etterpå, står på side én.', 1);
      }),
    );
    expect(units.map((unit) => unit.parts.map((part) => part.seq))).toEqual([[], [0, 1]]);
    expect(units[1]).toMatchObject({ seqFrom: 0, seqTo: 1, unitTo: 2 });
  });

  it('offsets count code points, not UTF-16 units', () => {
    const first = '𝑥 betegner antall saker.';
    const parts = partsOf(
      doc(1, (add) => {
        add.text('text', first, 1);
        add.text('text', 'Neste avsnitt.', 1);
      }),
    );
    expect(first.length).toBe(codePointLength(first) + 1);
    expect(parts[1]?.start).toBe(codePointLength(first) + 2);
    expect(codePointSlice(conversionText(parts), parts[1]?.start ?? 0, parts[1]?.end ?? 0)).toBe(
      'Neste avsnitt.',
    );
  });

  it("the conversion's text is the body parts' text joined by a blank line", () => {
    const parts = partsOf(
      doc(1, (add) => {
        add.text('page_header', 'Årsrapport 2023', 1, { top: 20 });
        add.text('section_header', 'Innledning', 1);
        add.text('text', 'Budsjettet  ble\noverholdt.', 1);
        add.text('text', '', 1);
        const list = add.group('list');
        add.text('list_item', 'Første punkt', 1, { parent: list });
      }),
    );
    const text = conversionText(parts);
    expect(text).toBe('Innledning\n\nBudsjettet ble overholdt.\n\nFørste punkt');
    for (const part of parts.filter((p) => p.layer === 'body'))
      expect(codePointSlice(text, part.start ?? -1, part.end ?? -1)).toBe(part.text);
    const empty = parts.find((part) => part.kind === 'text' && part.text === '');
    expect(empty?.start).toBe(empty?.end);
  });

  it('a page header is a furniture part with no offsets', () => {
    const [header] = partsOf(
      doc(1, (add) => {
        add.text('page_header', 'Årsrapport 2023', 1, { top: 20 });
        add.text('text', 'Budsjettet ble overholdt.', 1);
      }),
    );
    expect(header).toMatchObject({
      kind: 'page_header',
      layer: 'furniture',
      text: 'Årsrapport 2023',
      start: null,
      end: null,
      native: '#/texts/0',
    });
    expect(header?.regions).toMatchObject([{ unit: 1, start: null, end: null }]);
  });

  it('a label outside the list becomes text and is counted', () => {
    const document = doc(1, (add) => {
      add.text('reference', 'Lov om statens ansatte.', 1);
      add.text('handwritten_text', 'Godkjent.', 1);
      add.text('reference', 'Forskrift til loven.', 1);
    });
    const { units, unmapped } = doclingParts(document);
    expect(units[0]?.parts.map((part) => part.kind)).toEqual(['text', 'text', 'text']);
    expect(unmapped).toEqual({ reference: 2, handwritten_text: 1 });
  });

  it('a document_index and a checkbox keep their kind', () => {
    const parts = partsOf(
      doc(1, (add) => {
        add.table(1, [['1 Innledning', '3']], undefined, 0, 'document_index');
        add.text('checkbox_selected', 'Jeg samtykker', 1);
      }),
    );
    expect(parts.map((part) => part.kind)).toEqual(['document_index', 'checkbox_selected']);
  });

  it('a page with under 20 characters of other text takes its picture text', () => {
    const parts = partsOf(
      doc(2, (add) => {
        const chart = add.picture(1);
        add.text('text', 'Organisasjonskart', 1, { parent: chart });
        add.text('text', 'Direktør', 1, { parent: chart });
        const figure = add.picture(2);
        add.text('text', '2018 2019 2020', 2, { parent: figure });
        add.text('text', 'Lønnsutviklingen har vært jevn i hele perioden.', 2);
      }),
    );
    expect(parts.map((part) => [part.kind, part.text])).toEqual([
      ['picture', 'Organisasjonskart Direktør'],
      ['picture', ''],
      ['text', 'Lønnsutviklingen har vært jevn i hele perioden.'],
    ]);
  });

  it('a box is a fraction of the page from the top left, whichever origin the document uses', () => {
    const boxOf = (fromTop: boolean) =>
      partsOf(doc(1, (add) => add.text('text', 'Avsnitt.', 1, { top: 300, fromTop })))[0]
        ?.regions[0]?.box;
    expect(boxOf(false)).toEqual([0.0833, 0.375, 0.5, 0.39]);
    expect(boxOf(true)).toEqual(boxOf(false));
  });

  it("a region's span splits the part at the page break", () => {
    const text = 'Første  side slutter her.\nAndre side tar resten.';
    const parts = partsOf(
      doc(2, (add) => {
        add.text('text', 'Forrige avsnitt.', 1);
        add.text('text', text, 1, {
          places: [
            { page: 1, top: 700, charspan: [0, 25] },
            { page: 2, top: 60, charspan: [26, 48] },
          ],
        });
      }),
    );
    const joined = conversionText(parts);
    expect(
      parts[1]?.regions.map((region) => codePointSlice(joined, region.start ?? 0, region.end ?? 0)),
    ).toEqual(['Første side slutter her.', 'Andre side tar resten.']);
  });

  it("when the charspans do not cover the text, every region gets the part's whole span", () => {
    // Docling's charspans can end past the text, as when it joins a hyphenated word after counting.
    const text = 'Første side slutter her. Andre side tar resten.';
    const parts = partsOf(
      doc(2, (add) =>
        add.text('text', text, 1, {
          places: [
            { page: 1, top: 700, charspan: [0, 26] },
            { page: 2, top: 60, charspan: [27, 49] },
          ],
        }),
      ),
    );
    expect(parts[0]?.regions.map((region) => [region.unit, region.start, region.end])).toEqual([
      [1, 0, 47],
      [2, 0, 47],
    ]);
  });

  it("a lone number at a page's edge is a furniture part", () => {
    const parts = partsOf(
      doc(1, (add) => {
        add.text('text', 'Budsjettet ble overholdt.', 1);
        add.text('text', '12', 1, { top: 770 });
        add.text('text', '2023', 1, { top: 400 });
      }),
    );
    expect(parts.map((part) => [part.kind, part.layer, part.start])).toEqual([
      ['text', 'body', 0],
      ['text', 'furniture', null],
      ['text', 'body', 27],
    ]);
    expect(conversionText(parts)).toBe('Budsjettet ble overholdt.\n\n2023');
  });

  it('several boxes on one page give one region around them all', () => {
    const parts = partsOf(
      doc(1, (add) =>
        add.text('text', 'To linjer i to bokser.', 1, {
          places: [
            { page: 1, top: 100, charspan: [0, 9] },
            { page: 1, top: 200, charspan: [10, 22] },
          ],
        }),
      ),
    );
    expect(parts[0]?.regions).toHaveLength(1);
    expect(parts[0]?.regions[0]?.box).toEqual([0.0833, 0.125, 0.5, 0.265]);
  });

  it('a part has the texts of the headings above it as its heading path, outermost first', () => {
    const parts = partsOf(
      doc(1, (add) => {
        add.text('section_header', '1 Innledning', 1);
        add.text('section_header', '1.1 Bakgrunn', 1);
        add.text('text', 'Om bakgrunnen.', 1);
        add.text('section_header', '2 Mål', 1);
        add.text('text', 'Om målene.', 1);
      }),
    );
    expect(parts.map((part) => [part.level, part.headingPath])).toEqual([
      [1, []],
      [2, ['1 Innledning']],
      [null, ['1 Innledning', '1.1 Bakgrunn']],
      [1, []],
      [null, ['2 Mål']],
    ]);
  });

  it('offsets count code points over NFC text', () => {
    const decomposed = 'Gård og hus.';
    const parts = partsOf(
      doc(1, (add) => {
        add.text('text', decomposed, 1);
        add.text('text', 'Neste avsnitt.', 1);
      }),
    );
    expect(parts[0]?.text).toBe('Gård og hus.');
    expect(parts[0]?.end).toBe(12);
    expect(parts[1]?.start).toBe(14);
  });

  it("a row's text_start and text_end cover its parts' text", () => {
    const { units } = doclingParts(
      doc(3, (add) => {
        add.text('text', 'Én.', 1);
        add.text('text', 'Og to.', 1);
        add.text('page_footer', 'Side 1', 1, { top: 780 });
        add.text('text', 'Tre.', 2);
        add.text('page_footer', 'Side 3', 3, { top: 780 });
      }),
    );
    expect(units.map((unit) => [unit.textStart, unit.textEnd])).toEqual([
      [0, 11],
      [13, 17],
      [null, null],
    ]);
  });

  it('a box without an origin is read by its shape', () => {
    const boxOf = (fromTop: boolean) => {
      const document = doc(1, (add) => add.text('text', 'Avsnitt.', 1, { top: 300, fromTop }));
      for (const prov of (document.texts[0] as { prov: { bbox: Record<string, unknown> }[] }).prov)
        delete prov.bbox.coord_origin;
      return partsOf(document)[0]?.regions[0]?.box;
    };
    expect(boxOf(false)).toEqual([0.0833, 0.375, 0.5, 0.39]);
    expect(boxOf(true)).toEqual([0.0833, 0.375, 0.5, 0.39]);
  });

  it('a title is a level-1 heading', () => {
    const parts = partsOf(
      doc(1, (add) => {
        add.text('title', 'Årsrapport 2023', 1);
        add.text('text', 'Om året.', 1);
      }),
    );
    expect(parts.map((part) => [part.level, part.headingPath])).toEqual([
      [1, []],
      [null, ['Årsrapport 2023']],
    ]);
  });

  it("a table's text is its Markdown table", () => {
    const [table] = partsOf(
      doc(1, (add) =>
        add.table(
          1,
          [
            ['År', 'Beløp'],
            ['2023', '12'],
          ],
          undefined,
          1,
        ),
      ),
    );
    expect(table?.text).toBe('| År | Beløp |\n| --- | --- |\n| 2023 | 12 |');
  });

  it('an item without a content_layer is in the body', () => {
    const document = doc(1, (add) => add.text('text', 'Avsnitt.', 1));
    delete (document.texts[0] as { content_layer?: string }).content_layer;
    expect(partsOf(document)[0]).toMatchObject({ layer: 'body', start: 0, end: 8 });
  });

  it("an item under the document's furniture is a part too", () => {
    const document = doc(1, (add) => {
      add.text('text', 'Avsnitt.', 1);
      add.text('page_footer', 'Side 1', 1, { top: 780 });
    });
    const footer = document.body.children?.pop();
    document.furniture = { children: footer ? [footer] : [] };
    expect(partsOf(document).map((part) => [part.kind, part.layer, part.text])).toEqual([
      ['text', 'body', 'Avsnitt.'],
      ['page_footer', 'furniture', 'Side 1'],
    ]);
  });
});
