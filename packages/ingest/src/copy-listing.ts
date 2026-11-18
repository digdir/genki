import type {
  ExportedDocument,
  IndexChunk,
  IndexDocument,
  ListedDocument,
  ListedFile,
} from '@genai/port-knowledge';
import type { Listing } from './document-records.js';
import { assignChunkIds } from './ids.js';
import { kudosEarlierIds } from './kudos-earlier-ids.js';

export { copyOwner } from '@genai/port-knowledge';

/** How a copy renames its documents: `kudos` maps today's numeric Kudos ids to `kudos:<uuid>`. */
export type CopyIds = 'kudos';

/** What a copy reads from the dataset's current engine. */
export interface CopySource {
  list(): AsyncIterable<ExportedDocument>;
  document(id: string): Promise<IndexDocument | undefined>;
}

export interface CopyListingOptions {
  source: CopySource;
  ids?: CopyIds;
  /** Only these source ids, for a copy of named documents; such a listing is never complete. */
  documents?: string[];
  /** Earlier ids by `kudos:` id; `kudosEarlierIds()` by default. */
  earlierIds?: ReadonlyMap<string, string[]>;
}

/** A copy's listing, which also counts the documents it skipped, by reason. */
export interface CopyListing extends Listing<CopiedSource> {
  skipped(): Record<string, number>;
}

/** A document a copy loads as its engine holds it, chunks included, for the index job to write. */
export interface CopiedSource {
  copied: IndexDocument;
}

const filesOf = (fields: Record<string, unknown>): ListedFile[] =>
  (Array.isArray(fields.files) ? (fields.files as unknown[]) : []).flatMap((f) => {
    if (!f || typeof f !== 'object') return [];
    const file = f as Record<string, unknown>;
    const name = typeof file.url === 'string' ? file.url : file.filename;
    if (typeof name !== 'string') return [];
    return [{ name, ...(typeof file.sha256 === 'string' ? { sha256: file.sha256 } : {}) }];
  });

/** Today's numeric Kudos ids to their `kudos:` id, from the map of earlier ids. */
const kudosIdsOf = (earlierIds: ReadonlyMap<string, string[]>) => {
  const byNumber = new Map<string, string>();
  for (const [id, numbers] of earlierIds) for (const n of numbers) byNumber.set(n, id);
  return byNumber;
};

/**
 * Lists a dataset as its current engine holds it, for a copy into the knowledge database (#366):
 * every document once, under the id its pipeline would give it. With the Kudos map, a document
 * without a UUID is skipped as `no_uuid`, and of two that lead to one UUID the higher number is
 * copied and the other skipped as `same_uuid`.
 */
export const copyListing = (options: CopyListingOptions): CopyListing => {
  const named = options.documents ? new Set(options.documents) : undefined;
  const kudos =
    options.ids === 'kudos' ? kudosIdsOf(options.earlierIds ?? kudosEarlierIds()) : undefined;
  const earlier = options.ids === 'kudos' ? (options.earlierIds ?? kudosEarlierIds()) : undefined;
  let skipped: Record<string, number> = {};
  let complete = false;
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  return {
    deletes: 'listed',
    documents: async function* () {
      complete = false;
      skipped = {};
      const chosen = new Map<string, ExportedDocument>();
      for await (const doc of options.source.list()) {
        if (named && !named.has(doc.id)) continue;
        const id = kudos ? kudos.get(doc.id) : doc.id;
        if (!id) {
          skip('no_uuid');
          continue;
        }
        const before = chosen.get(id);
        if (before) skip('same_uuid');
        if (!before || Number(doc.id) > Number(before.id)) chosen.set(id, doc);
      }
      for (const [id, doc] of chosen) {
        const earlierIds = earlier?.get(id);
        yield {
          id,
          record: { ...doc },
          metadata: { ...doc },
          files: filesOf(doc.fields),
          ...(earlierIds && earlierIds.length > 0 ? { earlierIds } : {}),
        } satisfies ListedDocument;
      }
      // A copy of named documents lists part of the dataset, so it never deletes the rest.
      complete = !named;
    },
    complete: () => complete,
    skipped: () => ({ ...skipped }),
    load: async (record) => {
      const copied = await options.source.document(String(record.id));
      if (!copied) throw new Error('the document is gone from its engine');
      return { copied };
    },
  };
};

const pageBreak = /^\{(\d+)\}\n\n-{48}/gm;

/**
 * Pages from Marker's page breaks (`{n}` and a dashed line where page n + 1 starts): a chunk is on
 * the page it starts on, carried from the last break before it, and `pageEnd` is the page it ends on.
 */
const withPages = (chunks: IndexChunk[]): IndexChunk[] => {
  let current: number | undefined;
  return chunks.map((chunk) => {
    const breaks = [...chunk.text.matchAll(pageBreak)];
    const first = breaks[0];
    const startsOnBreak = first !== undefined && chunk.text.slice(0, first.index).trim() === '';
    const start = startsOnBreak ? Number(first[1]) + 1 : current;
    const last = breaks.at(-1);
    const end = last ? Number(last[1]) + 1 : start;
    current = end;
    if (start === undefined) return chunk;
    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        page: start,
        ...(end !== undefined && end > start ? { pageEnd: end } : {}),
      },
    };
  });
};

/** The copied document under its record's id, with chunk ids of its own and Marker's pages. */
export const copiedDocument = (id: string, source: IndexDocument): IndexDocument => {
  const ordered = [...source.chunks].sort((a, b) => a.position - b.position);
  const ids = assignChunkIds(
    id,
    ordered.map((c) => ({ content_markdown: c.text })),
  );
  const chunks = ordered.map(({ vector: _vector, ...chunk }, i) => ({
    ...chunk,
    id: ids[i]?.chunk_id ?? chunk.id,
  }));
  return { ...source, id, chunks: withPages(chunks), phrases: [] };
};
