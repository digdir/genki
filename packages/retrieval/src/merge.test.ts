import { describe, expect, it } from 'vitest';
import {
  dedupeHits,
  defaultStrategyWeights,
  mergeStrategyLists,
  normalizeRanks,
  type MergeOptions,
  type StrategyHit,
} from './merge.js';

const at = <T>(items: readonly T[] | undefined, i: number): T => {
  const item = items?.[i];
  if (item === undefined) throw new Error(`missing item ${i}`);
  return item;
};

const options = (overrides: Partial<MergeOptions> = {}): MergeOptions => ({
  mode: 'weighted-sum',
  weights: { ...defaultStrategyWeights, ...(overrides.weights ?? {}) },
  caps: overrides.caps ?? {},
  rrfK: overrides.rrfK ?? 60,
  ...(overrides.mode ? { mode: overrides.mode } : {}),
});

const hits = (type: string, rows: [string, number, number][]): StrategyHit[] =>
  rows.map(([id, rank, index]) => ({ id, rank, index, searchType: type }));

describe('merge regression fixture from headless-rag', () => {
  const cases = [
    {
      id: 'digdir-arsverk-base',
      golden: '6a80d6499075',
      maxRank: 1,
      phrase: hits('phrase', [
        ['792beec82d38', 0.98, 0],
        ['792beec82d38', 0.97, 1],
        ['181cd3add336', 0.96, 2],
        ['6a80d6499075', 0.31, 3],
      ]),
      metadata: hits('metadata', [['792beec82d38', 0.81, 0]]),
      content: hits('content', [
        ['6a80d6499075', 0.95, 0],
        ['792beec82d38', 0.1, 1],
      ]),
    },
    {
      id: 'digdir-arsverk-variant',
      golden: '6a80d6499075',
      maxRank: 2,
      phrase: hits('phrase', [
        ['842fe7e2695e', 0.97, 0],
        ['15a66d5ec5c5', 0.95, 1],
        ['6a80d6499075', 0.34, 2],
      ]),
      metadata: hits('metadata', [
        ['792beec82d38', 0.79, 0],
        ['842fe7e2695e', 0.73, 1],
      ]),
      content: hits('content', [
        ['6a80d6499075', 0.88, 0],
        ['842fe7e2695e', 0.52, 1],
        ['15a66d5ec5c5', 0.49, 2],
      ]),
    },
    {
      id: 'innovation-en-2022',
      golden: '391859380a9f',
      maxRank: 1,
      phrase: hits('phrase', [
        ['1234567890ab', 0.93, 0],
        ['391859380a9f', 0.58, 1],
      ]),
      metadata: hits('metadata', [['391859380a9f', 0.77, 0]]),
      content: hits('content', [
        ['391859380a9f', 0.99, 0],
        ['1234567890ab', 0.21, 1],
      ]),
    },
  ];

  it.each(cases)('keeps the golden chunk within rank bounds: $id', (c) => {
    const merged = mergeStrategyLists([c.phrase, c.metadata, c.content], options());
    const position = merged.findIndex((m) => m.id === c.golden) + 1;
    expect(position).toBeGreaterThan(0);
    expect(position).toBeLessThanOrEqual(c.maxRank);
  });

  it('computes the weighted sum exactly as headless-rag does', () => {
    const base = at(cases, 0);
    const merged = mergeStrategyLists([base.phrase, base.metadata, base.content], options());

    expect(merged.map((m) => m.id)).toEqual(['6a80d6499075', '792beec82d38', '181cd3add336']);
    expect(merged[0]?.rank).toBeCloseTo(1.0, 10);
    expect(merged[1]?.rank).toBeCloseTo(0.7 + 0.2, 10);
    expect(merged[2]?.rank).toBeCloseTo(0.7 * (0.65 / 0.67), 10);
    expect(merged[1]).toMatchObject({
      hitCount: 3,
      rawHitCount: 4,
      index: 0,
      searchTypes: ['phrase', 'metadata', 'content'],
    });
  });
});

describe('merge behaviour ported from core_merge_test', () => {
  it('prefers a strong content signal when phrase and content disagree', () => {
    const merged = mergeStrategyLists(
      [
        hits('phrase', [
          ['distractor', 0.99, 0],
          ['golden', 0.2, 1],
        ]),
        [],
        hits('content', [
          ['golden', 0.9, 0],
          ['distractor', 0.1, 1],
        ]),
      ],
      options(),
    );
    expect(merged[0]?.id).toBe('golden');
    expect(at(merged, 0).rank).toBeGreaterThan(at(merged, 1).rank);
  });

  it('caps repeated hits from one strategy at one contribution, and the cap is configurable', () => {
    const dup = hits('phrase', [
      ['dup', 0.99, 0],
      ['dup', 0.98, 1],
      ['dup', 0.97, 2],
    ]);
    expect(mergeStrategyLists([dup], options())[0]).toMatchObject({ hitCount: 1, rawHitCount: 3 });
    expect(mergeStrategyLists([dup], options({ caps: { phrase: 2 } }))[0]).toMatchObject({
      hitCount: 2,
      rawHitCount: 3,
    });
  });

  it('gives a phrase-only answer about twice the rank it had under the old phrase weight', () => {
    const phrase = hits('phrase', [
      ['answer', 0.9, 0],
      ['distractor', 0.5, 1],
      ['filler', 0.1, 2],
    ]);
    const content = hits('content', [
      ['distractor', 0.7, 0],
      ['filler', 0.3, 1],
    ]);
    const now =
      mergeStrategyLists([phrase, [], content], options()).find((m) => m.id === 'answer')?.rank ??
      0;
    const before =
      mergeStrategyLists(
        [phrase, [], content],
        options({ weights: { content: 1.0, phrase: 0.35, metadata: 0.2, unknown: 0.15 } }),
      ).find((m) => m.id === 'answer')?.rank ?? 0;
    expect(now).toBeGreaterThanOrEqual(0.65);
    expect(before).toBeLessThanOrEqual(0.4);
  });

  it('ranks content over doc-title over phrase at equal normalised rank', () => {
    const merged = mergeStrategyLists(
      [
        hits('phrase', [['phrase-only', 0.9, 0]]),
        hits('doc-title', [['doc-title-only', 0.9, 0]]),
        hits('content', [['content-only', 0.9, 0]]),
      ],
      options(),
    );
    expect(merged.map((m) => m.id)).toEqual(['content-only', 'doc-title-only', 'phrase-only']);
  });

  it('uses the best index per strategy in RRF, and a smaller k spreads ranks more', () => {
    const dup = hits('phrase', [
      ['dup', 0.5, 0],
      ['dup', 0.5, 5],
      ['dup', 0.5, 10],
    ]);
    expect(
      mergeStrategyLists([dup], options({ mode: 'rrf', weights: { phrase: 1.0 } }))[0]?.rank,
    ).toBeCloseTo(1 / 61, 10);

    const two = hits('content', [
      ['top', 1.0, 0],
      ['bot', 1.0, 9],
    ]);
    const ratio = (k: number) => {
      const merged = mergeStrategyLists([two], options({ mode: 'rrf', rrfK: k }));
      return at(merged, 0).rank / at(merged, 1).rank;
    };
    expect(ratio(10)).toBeGreaterThan(ratio(60));
  });

  it('rewards agreement across strategies in RRF and CombMNZ', () => {
    const phrase = hits('phrase', [
      ['winner', 0.5, 0],
      ['phrase-only', 0.9, 1],
    ]);
    const content = hits('content', [
      ['winner', 0.5, 0],
      ['content-only', 0.9, 1],
    ]);
    expect(mergeStrategyLists([phrase, [], content], options({ mode: 'rrf' }))[0]?.id).toBe(
      'winner',
    );
    expect(mergeStrategyLists([phrase, [], content], options({ mode: 'combmnz' }))[0]?.id).toBe(
      'content-only',
    );
  });

  it('multiplies the best hit score into the RRF term in rrf-with-score', () => {
    const merged = mergeStrategyLists(
      [
        hits('content', [
          ['a', 10, 0],
          ['b', 0, 1],
        ]),
      ],
      options({ mode: 'rrf-with-score' }),
    );
    expect(merged.map((m) => [m.id, m.rank])).toEqual([
      ['a', 1 / 61],
      ['b', 0],
    ]);
  });
});

describe('per-list dedupe and normalisation', () => {
  it('keeps the strongest hit per chunk, then sorts by index', () => {
    const deduped = dedupeHits(
      hits('content', [
        ['b', 0.2, 0],
        ['a', 0.5, 1],
        ['b', 0.9, 2],
        ['a', 0.5, 3],
      ]),
    );
    expect(deduped.map((h) => [h.id, h.rank, h.index])).toEqual([
      ['a', 0.5, 1],
      ['b', 0.9, 2],
    ]);
  });

  it('maps equal ranks to 1.0 and an empty list to itself', () => {
    expect(
      normalizeRanks(
        hits('x', [
          ['a', 3, 0],
          ['b', 3, 1],
        ]),
      ).map((h) => h.rank),
    ).toEqual([1, 1]);
    expect(normalizeRanks([])).toEqual([]);
  });
});
