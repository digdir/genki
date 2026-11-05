import type { EmbeddingPort } from '@genai/port-embedding';
import { describe, expect, it, vi } from 'vitest';
import {
  indexRecord,
  ingestListing,
  metadataHash,
  planRun,
  type DocumentRecords,
  type ListedDocument,
  type OwnedRecord,
} from './document-records.js';

const listed = (id: string, sha256 = `sha-${id}`): ListedDocument => ({
  id,
  record: { path: `/docs/${id}.md` },
  metadata: { path: `/docs/${id}.md` },
  files: [{ name: `${id}.md`, sha256 }],
});

const owned = (id: string, over: Partial<OwnedRecord> = {}): OwnedRecord => ({
  number: id,
  id,
  metadataHash: metadataHash({ path: `/docs/${id}.md` }),
  files: [{ name: `${id}.md`, sha256: `sha-${id}` }],
  state: 'stored',
  missing: 0,
  change: 1,
  applied: 1,
  ...over,
});

const deletes = (plan: ReturnType<typeof planRun>) =>
  plan.writes.filter((w) => w.kind === 'delete').map((w) => ('id' in w ? w.id : ''));

describe('planRun', () => {
  it('a listed source deletes only after two complete listings', () => {
    const first = planRun([listed('a')], [owned('a'), owned('b')], {
      complete: true,
      deletes: 'listed',
    });
    expect(deletes(first)).toEqual([]);
    expect(first.writes).toContainEqual({ kind: 'missing', id: 'b' });
    const second = planRun([listed('a')], [owned('a'), owned('b', { missing: 1 })], {
      complete: true,
      deletes: 'listed',
    });
    expect(deletes(second)).toEqual(['b']);
    expect(second.process).toContain('b');
    expect(second.counts.deleted).toBe(1);
  });

  it('an unchanged record takes the earlier ids its listing now carries, without being processed', () => {
    const plan = planRun([{ ...listed('a'), earlierIds: ['377252'] }], [owned('a')], {
      complete: true,
      deletes: 'listed',
    });

    expect(plan.writes).toEqual([{ kind: 'seen', id: 'a', earlierIds: ['377252'] }]);
    expect(plan.process).toEqual([]);
    expect(plan.counts.unchanged).toBe(1);
  });

  it('an incomplete listing deletes nothing', () => {
    const plan = planRun([listed('a')], [owned('a'), owned('b', { missing: 5 })], {
      complete: false,
      deletes: 'listed',
    });
    expect(deletes(plan)).toEqual([]);
    expect(plan.writes.some((w) => w.kind === 'missing')).toBe(false);
  });

  it('an empty listing deletes nothing', () => {
    for (const rule of ['listed', 'crawled'] as const) {
      const plan = planRun([], [owned('a', { missing: 1 }), owned('b', { missing: 4 })], {
        complete: true,
        deletes: rule,
      });
      expect(deletes(plan)).toEqual([]);
      expect(plan.writes).toEqual([]);
    }
  });

  it('deleting the last upload removes it at the next run', () => {
    const plan = planRun([], [owned('upload')], { complete: true, deletes: 'explicit' });
    expect(deletes(plan)).toEqual(['upload']);
  });

  it('a re-checked page that still answers is neither embedded nor rewritten', async () => {
    const calls: string[] = [];
    const record = {
      number: '9',
      dataset: 'digdir/site',
      id: 'p',
      record: { loc: 'https://www.example.no/p' },
      state: 'stored' as const,
      change: 4,
      gone: 0,
    };
    const records = {
      find: async () => record,
      held: async () => true,
      touch: async () => void calls.push('touch'),
      replace: async () => {
        calls.push('replace');
        return true;
      },
      fail: async () => undefined,
      writable: async () => true,
    } as unknown as DocumentRecords;
    const outcome = await indexRecord({
      records,
      listing: {
        deletes: 'crawled',
        load: async () => {
          calls.push('load');
          return {
            key: 'p',
            docNum: 'p',
            texts: ['# P\n\nInnhold.'],
            stored: () => ({ id: 'p', title: 'P' }),
            storedChunks: (chunks) => chunks.map((c) => ({ ...c })),
          };
        },
      },
      dataset: 'digdir/site',
      run: 'run-1',
      record: '9',
      generation: 'g-1',
      chunking: {
        strategy: { kind: 'header-based' },
        minimumLength: 1,
        maximumLength: 4000,
        metadataStyle: 'pr',
      },
      embedder: {
        info: () => ({ id: 'fake', dimensions: 3 }),
        embed: async () => {
          calls.push('embed');
          return { vectors: [] };
        },
      } as unknown as EmbeddingPort,
    });
    expect(outcome).toBe('checked');
    expect(calls).toEqual(['load', 'touch']);
  });

  it('an index job whose record changed while it ran fails, so its retry writes the newer change', async () => {
    const failed: string[] = [];
    const record = {
      number: '7',
      dataset: 'digdir/docs',
      id: 'a',
      record: { path: '/docs/a.md' },
      state: null,
      change: 3,
      gone: 0,
    };
    const records = {
      find: async () => record,
      replace: async () => false,
      fail: async (_r: unknown, reason: string) => void failed.push(reason),
      writable: async () => true,
    } as unknown as DocumentRecords;
    await expect(
      indexRecord({
        records,
        listing: {
          deletes: 'listed',
          load: async () => ({
            key: 'a',
            docNum: 'a',
            texts: ['# A\n\nInnhold.'],
            stored: () => ({ id: 'a', title: 'A' }),
            storedChunks: (chunks) => chunks.map((c) => ({ ...c })),
          }),
        },
        dataset: 'digdir/docs',
        run: 'run-1',
        record: '7',
        generation: 'g-1',
        chunking: {
          strategy: { kind: 'header-based' },
          minimumLength: 1,
          maximumLength: 4000,
          metadataStyle: 'pr',
        },
      }),
    ).rejects.toThrow('changed while its job ran');
    expect(failed).toEqual(['StaleRecord']);
  });

  it('an explicit delete removes at once', () => {
    const plan = planRun([listed('kept')], [owned('kept'), owned('upload')], {
      complete: true,
      deletes: 'explicit',
    });
    expect(deletes(plan)).toEqual(['upload']);
  });

  it('a crawled page is deleted after three complete crawls without it', () => {
    const missingTwice = planRun([listed('kept')], [owned('kept'), owned('page', { missing: 1 })], {
      complete: true,
      deletes: 'crawled',
    });
    expect(deletes(missingTwice)).toEqual([]);
    const third = planRun([listed('kept')], [owned('kept'), owned('page', { missing: 2 })], {
      complete: true,
      deletes: 'crawled',
    });
    expect(deletes(third)).toEqual(['page']);
  });

  it('a crawled page not written for 7 days is downloaded again, so a removed page is found', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
    const records = [
      owned('fresh', { appliedAt: daysAgo(6) }),
      owned('old', { appliedAt: daysAgo(8) }),
    ];
    const crawled = planRun([listed('fresh'), listed('old')], records, {
      complete: true,
      deletes: 'crawled',
      now,
    });
    expect(crawled.process).toEqual(['old']);
    expect(crawled.counts).toMatchObject({ unchanged: 2 });
    const folder = planRun([listed('fresh'), listed('old')], records, {
      complete: true,
      deletes: 'listed',
      now,
    });
    expect(folder.process).toEqual([]);
  });

  it('a run writes every document its generation does not hold', () => {
    const plan = planRun(
      [listed('held'), listed('behind'), listed('absent')],
      [owned('held'), owned('behind', { change: 7, applied: 3 }), owned('absent', { change: 4 })],
      { complete: true, deletes: 'listed' },
    );
    expect(plan.process).toEqual(['behind', 'absent']);
    expect(plan.counts).toEqual({ new: 0, changed: 0, deleted: 0, unchanged: 3 });
  });

  it('counts new, changed and unchanged documents', () => {
    const plan = planRun(
      [listed('new'), listed('changed', 'sha-other'), listed('same')],
      [owned('changed'), owned('same')],
      { complete: true, deletes: 'listed' },
    );
    expect(plan.counts).toEqual({ new: 1, changed: 1, deleted: 0, unchanged: 1 });
    expect(plan.process).toEqual(['new', 'changed']);
  });
});

describe('ingestListing', () => {
  it('an unchanged document is neither fetched nor written', async () => {
    const load = vi.fn();
    const apply = vi.fn<DocumentRecords['apply']>(async () => undefined);
    const records = {
      owned: async () => [owned('a')],
      apply,
      writable: async () => true,
    } as unknown as DocumentRecords;
    const counts = await ingestListing({
      records,
      listing: {
        deletes: 'listed',
        complete: () => true,
        documents: async function* () {
          yield listed('a');
        },
      },
      dataset: 'digdir/docs',
      pipeline: 'docs',
      generation: 'g-1',
      send: async () => undefined,
    });
    expect(load).not.toHaveBeenCalled();
    expect(counts).toEqual({ new: 0, changed: 0, deleted: 0, unchanged: 1 });
    const plan = apply.mock.calls[0]?.[0].plan;
    expect(plan?.process).toEqual([]);
    expect(plan?.writes).toEqual([{ kind: 'seen', id: 'a' }]);
  });
});
