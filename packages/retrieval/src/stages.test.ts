import { describe, expect, it } from 'vitest';
import { retrievalConfig } from './config.js';
import {
  capPerDocument,
  detectOrgFilter,
  detectYears,
  fileDigestsOf,
  isNumericFactQuery,
  prioritize,
  relaxedCap,
  suppressDuplicateFiles,
  unionMerge,
  type Chunk,
} from './stages.js';

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

describe('auto-filter detection', () => {
  const facets = {
    orgs_long: [
      { value: 'Digitaliseringsdirektoratet', count: 40 },
      { value: 'IT', count: 3 },
    ],
    orgs_short: [{ value: 'Digdir', count: 50 }],
  };

  it('prefers long organisation names, skips values under three characters, and finds years', () => {
    expect(
      detectOrgFilter(
        ['Hva gjør Digitaliseringsdirektoratet og Digdir?'],
        facets,
        ['orgs_long', 'orgs_short'],
        3,
      ),
    ).toEqual({
      field: 'orgs_long',
      values: ['Digitaliseringsdirektoratet'],
    });
    expect(detectOrgFilter(['IT i DIGDIR'], facets, ['orgs_long', 'orgs_short'], 3)).toEqual({
      field: 'orgs_short',
      values: ['Digdir'],
    });
    expect(
      detectOrgFilter(['ingen treff'], facets, ['orgs_long', 'orgs_short'], 3),
    ).toBeUndefined();
    expect(detectYears(['årsrapport 2021', 'og 2022'])).toEqual(['2021', '2022']);
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
