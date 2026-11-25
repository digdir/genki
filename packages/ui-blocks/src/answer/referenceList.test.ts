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

  it('gathers the pages of a document’s cited excerpts in runs, joined where they touch', () => {
    expect(
      pageRanges([
        [12, 13],
        [27, 27],
      ]),
    ).toBe('12–13, 27');
    expect(references(sources, pairing).map((r) => pageRanges(r.pages))).toEqual([
      '9',
      '12–13, 27',
      '11, 13',
      '10',
    ]);
  });

  it('counts an excerpt that runs over several pages as all of them, «s. 4–6»', () => {
    const long: SourceDocument = {
      title: 'Veileder',
      excerpts: [
        { chunkId: 'a', text: 'A', page: 4, pageEnd: 5 },
        { chunkId: 'b', text: 'B', page: 5, pageEnd: 6 },
        { chunkId: 'c', text: 'C', page: 9, pageEnd: 9 },
      ],
    };
    const marked = ['a', 'b', 'c'].map((chunkId, i) => ({ marker: String(i + 1), chunkId }));
    const list = references([long], readFootnotes('A [1] B [2] C [3]', [long], marked).pairing);
    expect(referencesMarkdown(list, 'nb')).toBe('- [1, 2, 3] *Veileder*. s. 4–6, 9.');
  });

  it('copies each document in APA 7, as publisher, year, title, pages and address, with its footnotes in brackets', () => {
    const list = references(sources, pairing, { numberEachFootnote: true });
    expect(referencesMarkdown(list, 'nb')).toBe(
      [
        '- [1] Nasjonal kommunikasjonsmyndighet. (2021). *Årsrapport 2020*. s. 9. <https://www.nkom.no/arsrapport-2020>',
        '- [2, 5, 6] Nasjonal kommunikasjonsmyndighet. (2022). *Årsrapport 2021*. s. 12–13, 27. <https://www.nkom.no/arsrapport-2021>',
        '- [3, 7] Nasjonal kommunikasjonsmyndighet. (2023). *Årsrapport 2022*. s. 11, 13. <https://www.nkom.no/arsrapport-2022>',
        '- [4] Nasjonal kommunikasjonsmyndighet. (2024). *Årsrapport 2023*. s. 10. <https://www.nkom.no/arsrapport-2023>',
      ].join('\n'),
    );
  });

  it('puts the title first when no publisher is named, as APA does, and leaves out each part the source lacks', () => {
    const bare: SourceDocument = {
      title: 'Veileder',
      publishedAt: '2024-05-01',
      excerpts: [{ chunkId: 'a', text: 'A' }],
    };
    const list = references(
      [bare],
      readFootnotes('A [1]', [bare], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(referencesMarkdown(list, 'nb')).toBe('- [1] *Veileder*. (2024).');
    const undated = references(
      [{ ...bare, publishedAt: undefined }],
      readFootnotes('A [1]', [bare], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(referencesMarkdown(undated, 'nb')).toBe('- [1] *Veileder*.');
  });

  it('leaves the document type out, as an APA reference does', () => {
    const list = references(sources, pairing);
    expect(referencesMarkdown(list, 'nb')).not.toContain('Årsrapport, ');
  });

  it('says «pp.» in English for more than one page', () => {
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
    expect(referencesMarkdown(list, 'en')).toBe('- [1, 2] *Guide*. pp. 4–5.');
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
      String.raw`- [1] A\_B. *Rapport \*utkast\* \[1\]*.`,
    );
  });

  it('puts no full stop after a title or publisher that already ends with one, or with a question', () => {
    const asked: SourceDocument = {
      title: 'Hva er kunstig intelligens?',
      publisher: 'Nkom m.fl.',
      excerpts: [{ chunkId: 'a', text: 'A' }],
    };
    const list = references(
      [asked],
      readFootnotes('A [1]', [asked], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(referencesMarkdown(list, 'nb')).toBe('- [1] Nkom m.fl. *Hva er kunstig intelligens?*');
  });

  it('copies an ampersand as itself, never as the start of an HTML entity', () => {
    const entity: SourceDocument = {
      title: 'Rapport &lt;utkast&gt;',
      excerpts: [{ chunkId: 'a', text: 'A' }],
    };
    const list = references(
      [entity],
      readFootnotes('A [1]', [entity], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(referencesMarkdown(list, 'nb')).toBe(String.raw`- [1] *Rapport \&lt;utkast\&gt;*.`);
  });

  it('copies no address with an angle bracket, which would end its link early', () => {
    const sly: SourceDocument = {
      title: 'Rapport',
      url: 'https://nkom.no>[Logg-inn](https://evil.example/login)',
      excerpts: [{ chunkId: 'a', text: 'A' }],
    };
    const list = references(
      [sly],
      readFootnotes('A [1]', [sly], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(list[0]?.url).toBeUndefined();
    expect(referencesMarkdown(list, 'nb')).toBe('- [1] *Rapport*.');
  });

  it('keeps each document on one line, whatever line breaks its title or publisher has', () => {
    const broken: SourceDocument = {
      title: 'Rapport\n- [9] Falsk kilde',
      publisher: 'Nkom\r\n\nAS',
      excerpts: [{ chunkId: 'a', text: 'A' }],
    };
    const list = references(
      [broken],
      readFootnotes('A [1]', [broken], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    expect(referencesMarkdown(list, 'nb')).toBe(
      String.raw`- [1] Nkom AS. *Rapport - \[9\] Falsk kilde*.`,
    );
  });

  it('reads a long hostile title, address and page span in linear time', () => {
    const long: SourceDocument = {
      title: `${' \n'.repeat(50_000)}*`,
      url: `https://${'a'.repeat(100_000)}<`,
      excerpts: [{ chunkId: 'a', text: 'A', page: 1, pageEnd: Number.MAX_SAFE_INTEGER }],
    };
    const started = performance.now();
    const list = references(
      [long],
      readFootnotes('A [1]', [long], [{ marker: '1', chunkId: 'a' }]).pairing,
    );
    referencesMarkdown(list, 'nb');
    expect(performance.now() - started).toBeLessThan(200);
    expect(list[0]?.url).toBeUndefined();
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
