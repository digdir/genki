import { describe, expect, it, vi } from 'vitest';
import {
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

  it('an incomplete listing deletes nothing', () => {
    const plan = planRun([listed('a')], [owned('a'), owned('b', { missing: 5 })], {
      complete: false,
      deletes: 'listed',
    });
    expect(deletes(plan)).toEqual([]);
    expect(plan.writes.some((w) => w.kind === 'missing')).toBe(false);
  });

  it('an explicit delete removes at once', () => {
    const plan = planRun([], [owned('upload')], { complete: true, deletes: 'explicit' });
    expect(deletes(plan)).toEqual(['upload']);
  });

  it('a crawled page is deleted after three complete crawls without it', () => {
    const missingTwice = planRun([], [owned('page', { missing: 1 })], {
      complete: true,
      deletes: 'crawled',
    });
    expect(deletes(missingTwice)).toEqual([]);
    const third = planRun([], [owned('page', { missing: 2 })], {
      complete: true,
      deletes: 'crawled',
    });
    expect(deletes(third)).toEqual(['page']);
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
