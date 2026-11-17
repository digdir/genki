import { describe, expect, it } from 'vitest';
import type { SourceDocument } from '../sources/types.js';
import { readFootnotes, type AnswerMarker } from './citations.js';
import { pageRanges, references, referencesMarkdown } from './referenceList.js';

const report = (year: number, pages: number[]): SourceDocument => ({
  title: `Årsrapport ${year - 1}`,
  documentType: 'Årsrapport',
  publisher: 'Nasjonal kommunikasjonsmyndighet',
  documentId: `nkom-${year}`,
  url: `https://www.nkom.no/arsrapport-${year - 1}`,
  publishedAt: `${year}-03-01`,
  excerpts: pages.map((page, i) => ({ chunkId: `${year}-${i}`, text: 'Utdrag.', page })),
});

// The board's four reports: [1] the first, [2], [5], [6] the second, [3], [7] the third, [4] the last.
const sources = [
  report(2021, [9]),
  report(2022, [12, 13, 27]),
  report(2023, [11, 13]),
  report(2024, [10]),
];
const cites = ['2021-0', '2022-0', '2023-0', '2024-0', '2022-1', '2022-2', '2023-1'];
const markers: AnswerMarker[] = cites.map((chunkId, i) => ({ marker: String(i + 1), chunkId }));
const text = cites.map((_, i) => `Setning ${i + 1} [${i + 1}].`).join(' ');
const { pairing } = readFootnotes(text, sources, markers);

describe('the Kildeliste', () => {
  it('lists each document once, with every footnote that cites it, sorted by the first', () => {
    const list = references(sources, pairing, { numberEachFootnote: true });
    expect(list.map((r) => [r.footnotes.join(', '), r.title])).toEqual([
      ['1', 'Årsrapport 2020'],
      ['2, 5, 6', 'Årsrapport 2021'],
      ['3, 7', 'Årsrapport 2022'],
      ['4', 'Årsrapport 2023'],
    ]);
  });

  it('gathers the pages of a document’s cited excerpts, each once, in runs', () => {
    expect(pageRanges([12, 13, 27])).toBe('12–13, 27');
    expect(pageRanges([1, 2, 3, 5, 7, 8])).toBe('1–3, 5, 7–8');
    expect(references(sources, pairing).map((r) => pageRanges(r.pages))).toEqual([
      '9',
      '12–13, 27',
      '11, 13',
      '10',
    ]);
  });

  it('copies each document as type, year, title, publisher, pages and address, with its footnotes in brackets', () => {
    const list = references(sources, pairing, { numberEachFootnote: true });
    expect(referencesMarkdown(list, 'nb')).toBe(
      [
        '- [1] Årsrapport, 2021, *Årsrapport 2020*. Nasjonal kommunikasjonsmyndighet. Side 9. <https://www.nkom.no/arsrapport-2020>',
        '- [2, 5, 6] Årsrapport, 2022, *Årsrapport 2021*. Nasjonal kommunikasjonsmyndighet. Side 12–13, 27. <https://www.nkom.no/arsrapport-2021>',
        '- [3, 7] Årsrapport, 2023, *Årsrapport 2022*. Nasjonal kommunikasjonsmyndighet. Side 11, 13. <https://www.nkom.no/arsrapport-2022>',
        '- [4] Årsrapport, 2024, *Årsrapport 2023*. Nasjonal kommunikasjonsmyndighet. Side 10. <https://www.nkom.no/arsrapport-2023>',
      ].join('\n'),
    );
  });

  it('leaves out each part the source lacks, as genki’s sources lack type, publisher and pages', () => {
    const bare: SourceDocument = {
      title: 'Veileder',
      publishedAt: '2024-05-01',
      excerpts: [{ chunkId: 'a', text: 'A' }],
    };
    const list = references(
      [bare],
      readFootnotes('A [1]', [bare], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(referencesMarkdown(list, 'nb')).toBe('- [1] 2024, *Veileder*.');
    const undated = references(
      [{ ...bare, publishedAt: undefined }],
      readFootnotes('A [1]', [bare], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(referencesMarkdown(undated, 'nb')).toBe('- [1] *Veileder*.');
  });

  it('says «Pages» in English for more than one page', () => {
    const one: SourceDocument = {
      title: 'Guide',
      excerpts: [
        { chunkId: 'a', text: 'A', page: 4 },
        { chunkId: 'b', text: 'B', page: 5 },
      ],
    };
    const marked = [
      { marker: '1', chunkId: 'a' },
      { marker: '2', chunkId: 'b' },
    ];
    const list = references([one], readFootnotes('A [1] B [2]', [one], marked).pairing);
    expect(referencesMarkdown(list, 'en')).toBe('- [1, 2] *Guide*. Pages 4–5.');
  });

  it('keeps Markdown characters as words, and copies no address that is not a web address', () => {
    const odd: SourceDocument = {
      title: 'Rapport *utkast* [1]',
      publisher: 'A_B',
      url: 'javascript:alert(1)',
      excerpts: [{ chunkId: 'a', text: 'A' }],
    };
    const list = references(
      [odd],
      readFootnotes('A [1]', [odd], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(list[0]?.url).toBeUndefined();
    expect(referencesMarkdown(list, 'nb')).toBe(
      String.raw`- [1] *Rapport \*utkast\* \[1\]*. A\_B.`,
    );
  });

  it('gives a document cited as a whole its mark’s number and no pages', () => {
    // Without markers, [N] is the source with index N.
    const whole = sources.map((s, i) => ({ ...s, index: i + 1 }));
    const read = readFootnotes('A [3]. B [1]. C [3].', whole);
    const list = references(whole, read.pairing, { documentFootnotes: true });
    expect(list.map((r) => [r.footnotes, r.title, r.pages])).toEqual([
      [[1], 'Årsrapport 2022', []],
      [[2], 'Årsrapport 2020', []],
    ]);
  });
});
