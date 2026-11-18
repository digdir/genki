import { describe, expect, it } from 'vitest';
import type { ExportedDocument, IndexDocument } from '@genai/port-knowledge';
import { copiedDocument, copyListing, type CopiedSource, type CopySource } from './copy-listing.js';
import { planRun } from './document-records.js';

// Marker's page break: `{n}` on a line of its own and a dashed line, where page n + 1 starts.
const page = (n: number) => `\n\n{${n}}\n\n${'-'.repeat(48)}\n\n`;

const doc = (
  id: string,
  chunks: string[],
  fields: Record<string, unknown> = {},
): IndexDocument => ({
  id,
  title: `Dokument ${id}`,
  fields,
  chunks: chunks.map((text, position) => ({
    id: `shared-${position}`,
    position,
    text,
    metadata: { metadata: '{"Header 1" "Årsrapport 2024"}\n' },
  })),
  phrases: [],
});

const sourceOf = (docs: IndexDocument[]): CopySource => ({
  list: async function* () {
    for (const { chunks, phrases, ...rest } of docs) {
      void chunks;
      void phrases;
      yield rest as ExportedDocument;
    }
  },
  document: async (id) => docs.find((d) => d.id === id),
});

const listAll = async (listing: ReturnType<typeof copyListing>) => {
  const listed = [];
  for await (const d of listing.documents()) listed.push(d);
  return listed;
};

// The map's shape: `kudos:` id to the numeric ids of today's index that lead to it.
const earlierIds = new Map([
  ['kudos:de77ffc7-1a57-456a-af49-167e699a4e6e', ['377252']],
  ['kudos:6431d31c-46a4-4163-b658-979f5d643e14', ['33', '2447']],
]);

describe('copying a dataset from its engine', () => {
  it('a copied Kudos document gets its kudos: id and keeps its old id as an earlier id', async () => {
    const listing = copyListing({
      source: sourceOf([doc('377252', ['Forord'], { type: 'Statusrapport' })]),
      ids: 'kudos',
      earlierIds,
    });
    const [listed] = await listAll(listing);
    expect(listed?.id).toBe('kudos:de77ffc7-1a57-456a-af49-167e699a4e6e');
    expect(listed?.earlierIds).toEqual(['377252']);
    expect(listed?.record).toMatchObject({ id: '377252', fields: { type: 'Statusrapport' } });
  });

  it('a dataset without a Kudos pipeline keeps its ids when copied', async () => {
    const listing = copyListing({ source: sourceOf([doc('15d652024721', ['Whitepaper'])]) });
    const [listed] = await listAll(listing);
    expect(listed?.id).toBe('15d652024721');
    expect(listed?.earlierIds).toBeUndefined();
  });

  it("two Typesense documents with one UUID copy the higher number's text and keep both numbers as earlier ids", async () => {
    const listing = copyListing({
      source: sourceOf([doc('2447', ['Nyere tekst']), doc('33', ['Eldre tekst'])]),
      ids: 'kudos',
      earlierIds,
    });
    const listed = await listAll(listing);
    expect(listed.map((l) => [l.id, l.record.id, l.earlierIds])).toEqual([
      ['kudos:6431d31c-46a4-4163-b658-979f5d643e14', '2447', ['33', '2447']],
    ]);
    expect(listing.skipped()).toEqual({ same_uuid: 1 });
    const loaded = (await listing.load(listed[0]?.record ?? {})) as CopiedSource;
    expect(loaded.copied.chunks.map((c) => c.text)).toEqual(['Nyere tekst']);
  });

  it('a Kudos document without a UUID is skipped as no_uuid', async () => {
    const listing = copyListing({
      source: sourceOf([doc('364', ['Borte']), doc('377252', ['Forord'])]),
      ids: 'kudos',
      earlierIds,
    });
    expect((await listAll(listing)).map((l) => l.id)).toEqual([
      'kudos:de77ffc7-1a57-456a-af49-167e699a4e6e',
    ]);
    expect(listing.skipped()).toEqual({ no_uuid: 1 });
  });

  it('copied chunks keep their text and order', async () => {
    const source = doc('377252', ['første', 'andre', 'tredje']);
    source.chunks.reverse();
    const copied = copiedDocument('kudos:de77ffc7-1a57-456a-af49-167e699a4e6e', source);
    expect(copied.chunks.map((c) => [c.position, c.text])).toEqual([
      [0, 'første'],
      [1, 'andre'],
      [2, 'tredje'],
    ]);
    expect(copied.chunks[0]?.metadata?.metadata).toBe('{"Header 1" "Årsrapport 2024"}\n');
    expect(copied.phrases).toEqual([]);
  });

  it("a copied chunk takes its page from Marker's page break", () => {
    const copied = copiedDocument(
      'kudos:x',
      doc('377252', [`${page(0)}Innhold${page(1)}Mer${page(2)}Forord`, `${page(4)}Kapittel 1`]),
    );
    expect(copied.chunks.map((c) => [c.metadata?.page, c.metadata?.pageEnd])).toEqual([
      [1, 3],
      [5, undefined],
    ]);
    expect(copied.chunks[0]?.text).toBe(`${page(0)}Innhold${page(1)}Mer${page(2)}Forord`);
  });

  it('a copied chunk without a page break is on the page the last break started', () => {
    const copied = copiedDocument(
      'kudos:x',
      doc('377252', [
        `${page(0)}Innhold${page(2)}Forord`,
        'Forord fortsetter',
        `Mer${page(3)}Neste`,
      ]),
    );
    expect(copied.chunks.map((c) => [c.metadata?.page, c.metadata?.pageEnd])).toEqual([
      [1, 3],
      [3, undefined],
      [3, 4],
    ]);
  });

  it('a document without page breaks gets no pages', () => {
    const copied = copiedDocument('15d652024721', doc('15d652024721', ['Whitepaper']));
    expect(copied.chunks[0]?.metadata).not.toHaveProperty('page');
  });

  it('copied chunks get ids of their own document, so two documents never share one', () => {
    const a = copiedDocument('kudos:a', doc('1', ['Samme tekst', 'Samme tekst']));
    const b = copiedDocument('kudos:b', doc('2', ['Samme tekst']));
    const ids = [...a.chunks, ...b.chunks].map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain('shared-0');
  });

  it('a copy of named documents deletes no other record', async () => {
    const listing = copyListing({
      source: sourceOf([doc('377252', ['Forord']), doc('2447', ['Strategi'])]),
      ids: 'kudos',
      earlierIds,
      documents: ['377252'],
    });
    const listed = await listAll(listing);
    expect(listed.map((l) => l.record.id)).toEqual(['377252']);
    expect(listing.complete()).toBe(false);
    const owned = {
      number: '7',
      id: 'kudos:6431d31c-46a4-4163-b658-979f5d643e14',
      metadataHash: 'x',
      files: [],
      state: 'stored' as const,
      missing: 1,
      change: 3,
      applied: 3,
    };
    const plan = planRun(listed, [owned], {
      complete: listing.complete(),
      deletes: listing.deletes,
    });
    expect(plan.writes.filter((w) => w.kind === 'missing' || w.kind === 'delete')).toEqual([]);
  });

  it('a copy of a whole dataset is complete once listed', async () => {
    const listing = copyListing({ source: sourceOf([doc('15d652024721', ['Whitepaper'])]) });
    await listAll(listing);
    expect(listing.complete()).toBe(true);
  });
});
