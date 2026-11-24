import { describe, expect, it } from 'vitest';
import { retrievalConfig } from './config.js';
import {
  capPerDocument,
  collapseReportCopies,
  detectOrganisations,
  detectYears,
  fileDigestsOf,
  isNumericFactQuery,
  prioritize,
  relaxedCap,
  suppressDuplicateFiles,
  unionMerge,
  type Chunk,
} from './stages.js';
import { tokenize } from './text.js';

const defaults = retrievalConfig.parse({});

const chunk = (id: string, extra: Partial<Chunk> = {}): Chunk => ({
  id,
  searchTypes: [],
  hitCount: 0,
  originalRank: 0,
  originalIndex: 0,
  typeRanks: {},
  fileDigests: [],
  orgs: [],
  fields: {},
  ...extra,
});

describe('query-aware boost', () => {
  const answer = chunk('a', {
    title: 'Årsrapport 2022 Digdir',
    text: 'Digdir hadde 326 årsverk i 2022.',
    searchTypes: ['content', 'phrase'],
    hitCount: 2,
    originalRank: 1,
    orgs: ['Digdir'],
  });
  const queries = ['Hvor mange årsverk hadde Digdir i 2022?'];

  it('adds every boost exactly as headless-rag does', () => {
    const [boosted] = prioritize(
      [answer],
      queries,
      { orgs_long: ['Digdir'] },
      ['orgs_long', 'orgs_short'],
      defaults.boostWeights,
      true,
    );

    expect(boosted?.retrievalBoosts).toEqual({
      title: 0.06,
      year: 0.15,
      org: 0.4,
      searchType: 0.35 + 0.08,
      contentOverlap: 0.2,
      numericEvidence: 0.45,
    });
    expect(boosted?.retrievalPrior).toBeCloseTo(
      2 + 0.1 + 0.06 + 0.15 + 0.4 + 0.43 + 0.2 + 0.45,
      10,
    );
  });

  it('ignores chunk content in metadata-only mode, as headless-rag never fetched it there', () => {
    const [boosted] = prioritize(
      [answer],
      queries,
      {},
      ['orgs_long'],
      defaults.boostWeights,
      false,
    );
    expect(boosted?.retrievalBoosts).toMatchObject({
      contentOverlap: 0.04 * 2,
      numericEvidence: 0,
      org: 0,
    });
  });

  it('sorts by prior, then hit count, then original rank, then chunk id', () => {
    const sorted = prioritize(
      [
        chunk('b', { hitCount: 1 }),
        chunk('a', { hitCount: 1 }),
        chunk('c', { hitCount: 1, originalRank: 0.5 }),
      ],
      ['x'],
      {},
      [],
      { ...defaults.boostWeights, originalRankWeight: 0 },
      true,
    );
    expect(sorted.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('recognises numeric fact questions in Norwegian and English', () => {
    expect(
      isNumericFactQuery(['Kor mange tilsette']) && isNumericFactQuery(['antall ansatte']),
    ).toBe(true);
    expect(isNumericFactQuery(['how many FTE'])).toBe(true);
    expect(isNumericFactQuery(['Hva er Altinn?'])).toBe(false);
  });
});

describe('diversity and duplicate files', () => {
  it('caps chunks per document, keyed on chunk id when there is no document', () => {
    const chunks = [
      chunk('1', { document: 'd' }),
      chunk('2', { document: 'd' }),
      chunk('3', { document: 'd' }),
      chunk('4'),
    ];
    expect(capPerDocument(chunks, 2).map((c) => c.id)).toEqual(['1', '2', '4']);
  });

  it('relaxes the default cap only for pools dominated by one document', () => {
    const dominated = [
      ...Array.from({ length: 25 }, (_, i) => chunk(`a${i}`, { document: 'a' })),
      ...Array.from({ length: 3 }, (_, i) => chunk(`b${i}`, { document: 'b' })),
      ...Array.from({ length: 3 }, (_, i) => chunk(`c${i}`, { document: 'c' })),
    ];
    expect(relaxedCap(dominated, 10, defaults.diversity)).toBe(50);
    expect(relaxedCap(dominated.slice(0, 29), 10, defaults.diversity)).toBe(10);
    expect(relaxedCap(dominated, 8, defaults.diversity)).toBe(8);
  });

  it('drops a second registration of the same single file, but never touches multi-file documents', () => {
    const kept = suppressDuplicateFiles([
      chunk('1', { document: 'd1', fileDigests: ['sha-a'] }),
      chunk('2', { document: 'd1', fileDigests: ['sha-a'] }),
      chunk('3', { document: 'd2', fileDigests: ['sha-a'] }),
      chunk('4', { document: 'd3', fileDigests: ['sha-a', 'sha-b'] }),
      chunk('5', { document: 'd4' }),
    ]);
    expect(kept.map((c) => c.id)).toEqual(['1', '2', '4', '5']);
  });

  it('reads file digests from the flat field first, then from the files array', () => {
    const base = { id: 'c', score: 0, text: '' };
    expect(
      fileDigestsOf({
        ...base,
        fields: { docs: { file_sha256: ['x'], files: [{ sha256: 'y' }] } },
      }),
    ).toEqual(['x']);
    expect(
      fileDigestsOf({ ...base, fields: { docs: { files: [{ sha256: 'y' }, { name: 'z' }] } } }),
    ).toEqual(['y']);
  });
});

describe('records of one report', () => {
  const key = 'årsrapport|983544622|2023|årsrapport helsedirektoratet 2023';
  const salary = 'For kvinner utgjorde gjennomsnittslønnen kr. 826 000, for menn kr. 861 000.';
  /** A hit from one KUDOS record of Helsedirektoratet's 2023 annual report (issue 677). */
  const record = (
    id: string,
    document: string,
    report: { own: boolean; date: string; pages: number },
    text = salary,
  ) =>
    chunk(id, {
      document,
      text,
      fields: {
        report: { key, own: report.own, pages: report.pages },
        publish_date: report.date,
        page: 18,
      },
    });
  const own = { own: true, date: '2024-04-15', pages: 151 };
  const sameYearCopy = { own: false, date: '2023-01-01', pages: 153 };
  const hod = { own: false, date: '2024-01-01', pages: 151 };

  it("hits on the same page of two records with one report key come back once, from the agency's own record", () => {
    const kept = collapseReportCopies([
      chunk('other-1', { document: 'other' }),
      record('hod#18', 'kudos:fdfac1a8', hod),
      record('own#18', 'kudos:51fe0107', own),
      record('dup#18', 'kudos:a2a2fe02', sameYearCopy),
      chunk('other-2', { document: 'other' }),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['other-1', 'own#18', 'other-2']);
    expect(kept[1]?.copies).toEqual([
      { id: 'hod#18', document: 'kudos:fdfac1a8' },
      { id: 'dup#18', document: 'kudos:a2a2fe02' },
    ]);
  });

  it('keeps the hits on pages only a copy has', () => {
    const kept = collapseReportCopies([
      record('own#18', 'kudos:51fe0107', own),
      record('hod#2', 'kudos:fdfac1a8', hod, 'Forord fra departementet om oppdraget og rammene.'),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['own#18', 'hod#2']);
  });

  it('a record whose page count differs by more than 5 % is not grouped', () => {
    const kept = collapseReportCopies([
      record('own#18', 'kudos:51fe0107', own),
      record('summary#18', 'kudos:summary', { own: true, date: '2024-05-01', pages: 140 }),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['own#18', 'summary#18']);
  });

  it('the kept record of a group is not a ministry copy and has a real publish date', () => {
    const kept = collapseReportCopies([
      record('dup#18', 'kudos:a2a2fe02', sameYearCopy),
      record('hod#18', 'kudos:fdfac1a8', hod),
      record('own#18', 'kudos:51fe0107', own),
      record('older#18', 'kudos:older', { own: true, date: '2024-03-01', pages: 151 }),
      record('later-hod#18', 'kudos:later', { own: false, date: '2025-01-01', pages: 151 }),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['own#18']);
  });

  it('a record joins a group only when its page count is within 5 % of every record in it', () => {
    const kept = collapseReportCopies([
      record('a#18', 'kudos:a', { own: false, date: '2024-01-01', pages: 100 }),
      record('b#18', 'kudos:b', { own: false, date: '2023-01-01', pages: 96 }),
      record('c#18', 'kudos:c', { own: true, date: '2024-04-15', pages: 104 }),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['a#18', 'c#18']);
  });

  it('a hit of only a few words never stands in for a longer hit on the same page', () => {
    const kept = collapseReportCopies([
      record('hod#18', 'kudos:fdfac1a8', hod),
      record('own#18', 'kudos:51fe0107', own, 'Side 18'),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['hod#18', 'own#18']);
  });

  it('names each left-out record once when hits already carrying copies are collapsed again', () => {
    const kept = collapseReportCopies([
      { ...record('own#18', 'kudos:own', own), copies: [{ id: 'hod#18', document: 'kudos:hod' }] },
      { ...record('hod#18', 'kudos:hod', hod), copies: [{ id: 'dup#18', document: 'kudos:dup' }] },
    ]);

    expect(kept.map((c) => c.copies)).toEqual([
      [
        { id: 'hod#18', document: 'kudos:hod' },
        { id: 'dup#18', document: 'kudos:dup' },
      ],
    ]);
  });

  it('two hits of one record are never collapsed into each other', () => {
    const kept = collapseReportCopies([
      record('own#18a', 'kudos:51fe0107', own),
      record('own#18b', 'kudos:51fe0107', own),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['own#18a', 'own#18b']);
  });

  it('hits without text are grouped only when their page and page count are equal', () => {
    const blank = (id: string, document: string, page: number, pages: number) =>
      chunk(id, {
        document,
        fields: { report: { key, own: document === 'own', pages }, page },
      });

    expect(
      collapseReportCopies([blank('a', 'copy', 18, 151), blank('b', 'own', 18, 151)]).map(
        (c) => c.id,
      ),
    ).toEqual(['b']);
    expect(
      collapseReportCopies([blank('a', 'copy', 18, 153), blank('b', 'own', 18, 151)]).map(
        (c) => c.id,
      ),
    ).toEqual(['a', 'b']);
    expect(
      collapseReportCopies([blank('a', 'copy', 17, 151), blank('b', 'own', 18, 151)]).map(
        (c) => c.id,
      ),
    ).toEqual(['a', 'b']);
  });

  it('hits of only a few words are grouped only on the same page', () => {
    const footer = (id: string, document: string, page: number) =>
      chunk(id, {
        document,
        text: 'Helsedirektoratet årsrapport 2023',
        fields: { report: { key, own: document === 'own', pages: 151 }, page },
      });

    expect(
      collapseReportCopies([footer('a', 'copy', 3), footer('b', 'own', 40)]).map((c) => c.id),
    ).toEqual(['a', 'b']);
    expect(
      collapseReportCopies([footer('a', 'copy', 3), footer('b', 'own', 3)]).map((c) => c.id),
    ).toEqual(['b']);
  });

  it('a kept hit never lists itself among the records it left out', () => {
    const tie = { own: true, date: '2024-04-15', pages: 151 };
    const [first] = collapseReportCopies([
      record('a#18', 'kudos:a', tie),
      record('b#18', 'kudos:b', tie),
    ]);
    const [second] = collapseReportCopies([
      record('b#18', 'kudos:b', tie),
      record('a#18', 'kudos:a', tie),
    ]);

    const kept = collapseReportCopies([first as Chunk, second as Chunk]);

    expect(kept.map((c) => [c.id, c.copies?.map((x) => x.id)])).toEqual([['a#18', ['b#18']]]);
  });

  describe('a copy whose PDF is cut into chunks at other places', () => {
    const words = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
    // The HOD copy's chunk of the 826 000 page starts and ends elsewhere than the agency's own.
    const table = `${salary} ${words('rad', 119)}`;
    const ownChunk = `# Redegjørelse om likestilling ${table} ${words('innledning', 23)}`;
    const hodChunk = `# Kjønnsbalanse ${table} ${words('sluttrad', 11)}`;

    it('the regression chunks overlap less than 0.8 over both word sets, as the HOD copy did in test', () => {
      const own = tokenize(ownChunk);
      const copy = tokenize(hodChunk);

      const shared = [...own].filter((w) => copy.has(w)).length;

      expect([own.size, copy.size, shared]).toEqual([154, 140, 128]);
      expect(shared / (own.size + copy.size - shared)).toBeLessThan(0.8);
    });

    it("a copy's hit is grouped with the own record's hit when nearly all of the shorter hit's words are in the other", () => {
      const kept = collapseReportCopies([
        record('hod#17', 'kudos:fdfac1a8', hod, hodChunk),
        record('own#15', 'kudos:51fe0107', own, ownChunk),
      ]);

      expect(kept.map((c) => c.id)).toEqual(['own#15']);
      expect(kept[0]?.copies).toEqual([{ id: 'hod#17', document: 'kudos:fdfac1a8' }]);
    });

    it('two different pages of one report that share ordinary words are not grouped', () => {
      const ordinary = `Helsedirektoratet 2023 og i for med som til av på er det ${words('felles', 40)}`;
      const kept = collapseReportCopies([
        record('hod#17', 'kudos:fdfac1a8', hod, `${ordinary} ${words('side17', 90)}`),
        record('own#18', 'kudos:51fe0107', own, `${ordinary} ${words('side18', 90)}`),
      ]);

      expect(kept.map((c) => c.id)).toEqual(['hod#17', 'own#18']);
    });

    it('a short hit whose words are all in a much longer hit is not grouped with it', () => {
      const kept = collapseReportCopies([
        record(
          'hod#40',
          'kudos:fdfac1a8',
          hod,
          'Redegjørelse om likestilling. For kvinner utgjorde gjennomsnittslønnen rad1 rad2 rad3',
        ),
        record('own#15', 'kudos:51fe0107', own, ownChunk),
      ]);

      expect(kept.map((c) => c.id)).toEqual(['hod#40', 'own#15']);
    });
  });

  it('two short pages of one report that differ by one word are not grouped', () => {
    const kept = collapseReportCopies([
      record('hod#30', 'kudos:fdfac1a8', hod, 'Del 2 Årsrapport Helsedirektoratet 2023'),
      record('own#40', 'kudos:51fe0107', own, 'Del 3 Årsrapport Helsedirektoratet 2023'),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['hod#30', 'own#40']);
  });

  it("a copy's hit spanning two pages is not grouped with the own record's hit on one of them", () => {
    const words = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
    const kept = collapseReportCopies([
      record('hod#17', 'kudos:fdfac1a8', hod, `${words('side17', 80)} ${words('side18', 80)}`),
      record('own#17', 'kudos:51fe0107', own, words('side17', 80)),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['hod#17', 'own#17']);
  });

  it('a hit joins a group only when it is the same page as every hit in it', () => {
    const words = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
    const kept = collapseReportCopies([
      record('own#15', 'kudos:51fe0107', own, `${words('a', 100)} ${words('b', 40)}`),
      record('hod#15', 'kudos:fdfac1a8', hod, `${words('a', 100)} ${words('b', 80)}`),
      record('dup#16', 'kudos:a2a2fe02', sameYearCopy, `${words('a', 60)} ${words('b', 80)}`),
    ]);

    expect(kept.map((c) => c.id)).toEqual(['own#15', 'dup#16']);
  });

  it('a record with no page count is never grouped', () => {
    const noPages = chunk('np', {
      document: 'np',
      text: salary,
      fields: { report: { key, own: true } },
    });

    expect(
      collapseReportCopies([record('hod#18', 'kudos:fdfac1a8', hod), noPages]).map((c) => c.id),
    ).toEqual(['hod#18', 'np']);
  });

  it('leaves hits with no report key as they are', () => {
    const hits = [
      chunk('a', { document: 'd1', text: salary }),
      chunk('b', { document: 'd2', text: salary }),
    ];

    expect(collapseReportCopies(hits)).toEqual(hits);
  });
});

describe('auto-filter detection', () => {
  const facets = {
    orgs_long: [
      { value: 'Datatilsynet', count: 40 },
      { value: 'IT', count: 3 },
    ],
    orgs_short: [
      { value: 'NAV', count: 50 },
      { value: 'DFØ', count: 20 },
    ],
  };
  const fields = ['orgs_long', 'orgs_short'];

  it('a question naming two organisations detects both', () => {
    expect(detectOrganisations(['Datatilsynet og NAV'], facets, fields, 3)).toEqual([
      { field: 'orgs_long', values: ['Datatilsynet'], queries: ['Datatilsynet og NAV'] },
      { field: 'orgs_short', values: ['NAV'], queries: ['Datatilsynet og NAV'] },
    ]);
  });

  it('a genitive organisation name is detected', () => {
    const query = 'Datatilsynets arbeid ifølge DFØs evaluering';
    expect(detectOrganisations([query], facets, fields, 3)).toEqual([
      { field: 'orgs_long', values: ['Datatilsynet'], queries: [query] },
      { field: 'orgs_short', values: ['DFØ'], queries: [query] },
    ]);
  });

  it('lower-case æøå match their capitals', () => {
    expect(detectOrganisations(['hva sier dfø'], facets, fields, 3)).toEqual([
      { field: 'orgs_short', values: ['DFØ'], queries: ['hva sier dfø'] },
    ]);
  });

  it('records only the queries that name the organisation', () => {
    expect(detectOrganisations(['NAV i 2022', 'årsrapport'], facets, fields, 3)).toEqual([
      { field: 'orgs_short', values: ['NAV'], queries: ['NAV i 2022'] },
    ]);
  });

  it('skips facet values shorter than the minimum length', () => {
    expect(detectOrganisations(['IT i staten'], facets, fields, 3)).toEqual([]);
  });

  it('an amount is not read as a year', () => {
    expect(detectYears(['Kostnad på 2000 kroner i 2023'])).toEqual(['2023']);
  });

  it('an amount does not lift a title that contains the same number', () => {
    const [ranked] = prioritize(
      [chunk('c', { title: 'Rapport 2000' })],
      ['Kostnad på 2000 kroner'],
      {},
      [],
      defaults.boostWeights,
      false,
    );
    expect(ranked?.retrievalBoosts?.year).toBe(0);
  });
});

describe('user-intent union', () => {
  const intent = ['i1', 'shared', 'i2', 'i3'].map((id) => chunk(id));
  const expansion = ['e1', 'shared', 'e2'].map((id) => chunk(id));

  it('locks the intent prefix in cap mode', () => {
    expect(unionMerge(intent, expansion, 'cap', 3, 60).map((c) => c.id)).toEqual([
      'i1',
      'shared',
      'i2',
      'e1',
      'e2',
    ]);
  });

  it('alternates without duplicates in interleave mode', () => {
    expect(unionMerge(intent, expansion, 'interleave', 3, 60).map((c) => c.id)).toEqual([
      'i1',
      'e1',
      'shared',
      'i2',
      'e2',
      'i3',
    ]);
  });

  it('sums reciprocal ranks in rrf mode', () => {
    expect(unionMerge(intent, expansion, 'rrf', 3, 60).map((c) => c.id)[0]).toBe('shared');
  });
});

describe('document-title fanout as a setting', () => {
  it('accepts a fanout set without profiles and searches no titles', () => {
    expect(retrievalConfig.parse({ docTitle: { fanout: 3 } }).docTitle).toEqual({
      profiles: [],
      fanout: 3,
      maxDocs: 40,
    });
  });
});
