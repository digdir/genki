import type { SourceRef, TestSet } from './schema.js';

export interface LocatedChunk {
  id: string;
  document?: string;
  position?: number;
}

export type ChunkFetcher = (ids: string[]) => Promise<LocatedChunk[]>;

export interface MappingResult {
  set: TestSet;
  mapped: number;
  missing: string[];
}

const chunkIdsOf = (set: TestSet) => [
  ...new Set(
    set.spec.cases.flatMap((c) =>
      c.expected.sources.flatMap((s) => (s.chunkId === undefined ? [] : [s.chunkId])),
    ),
  ),
];

export const locateChunks = async (
  ids: string[],
  fetch: ChunkFetcher,
  batchSize = 100,
): Promise<Map<string, LocatedChunk>> => {
  const found = new Map<string, LocatedChunk>();
  for (let i = 0; i < ids.length; i += batchSize) {
    for (const chunk of await fetch(ids.slice(i, i + batchSize))) found.set(chunk.id, chunk);
  }
  return found;
};

const located = (source: SourceRef, found: Map<string, LocatedChunk>): SourceRef => {
  const chunk = source.chunkId === undefined ? undefined : found.get(source.chunkId);
  if (chunk?.document === undefined) return source;
  return {
    ...source,
    document: chunk.document,
    ...(chunk.position === undefined ? {} : { position: chunk.position }),
  };
};

export const mapSources = async (
  set: TestSet,
  fetch: ChunkFetcher,
  mappedOn: string,
  corpus: string,
): Promise<MappingResult> => {
  const ids = chunkIdsOf(set);
  const found = await locateChunks(ids, fetch);
  const missing = ids.filter((id) => found.get(id)?.document === undefined);
  const mapped = ids.length - missing.length;
  const cases = set.spec.cases.map((c) => ({
    ...c,
    expected: { ...c.expected, sources: c.expected.sources.map((s) => located(s, found)) },
  }));
  return {
    set: {
      ...set,
      spec: {
        ...set.spec,
        provenance: {
          ...set.spec.provenance,
          mapping:
            missing.length === 0
              ? `mapped to document + position against ${corpus} on ${mappedOn}`
              : `partly mapped against ${corpus} on ${mappedOn}: ${mapped} of ${ids.length} chunk ids found`,
          ...(missing.length === 0 ? {} : { unmappedChunkIds: missing }),
        },
        cases,
      },
    },
    mapped,
    missing,
  };
};

export const unreachable = (set: TestSet, checkedOn: string, tried: string[]): TestSet => ({
  ...set,
  spec: {
    ...set.spec,
    provenance: {
      ...set.spec.provenance,
      mapping: `pending: none of the chunk ids were found in ${tried.join(', ')} on ${checkedOn}; the corpus is not reachable with the platform's search key`,
    },
  },
});

/** A Kudos source's page: Docling's, or Marker's with why Docling gave none. */
export type KudosPage =
  { page: number; from: 'docling' } | { page?: number; from: 'marker'; reason: string };

const wordsOf = (text: string) =>
  new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3));

/**
 * The page of an old Kudos chunk as a knowledge fill numbers it: the Docling page that holds most of
 * the chunk's words, when one holds at least half of them, else the page Marker put it on.
 * `docling` holds each file's pages as `doclingPages` gives them, page n at index n - 1.
 */
export const kudosPage = (
  chunk: string,
  docling: readonly (readonly string[])[],
  marker?: number,
): KudosPage => {
  const words = wordsOf(chunk);
  let best: { page: number; found: number } | undefined;
  for (const pages of docling)
    pages.forEach((text, i) => {
      const onPage = wordsOf(text);
      const found = [...words].filter((w) => onPage.has(w)).length;
      if (!best || found > best.found) best = { page: i + 1, found };
    });
  const share = best && words.size > 0 ? best.found / words.size : 0;
  if (best && share >= 0.5) return { page: best.page, from: 'docling' };
  return {
    ...(marker === undefined ? {} : { page: marker }),
    from: 'marker',
    reason: best
      ? `Marker's page: no Docling page holds half its words (best page ${best.page}, ${Math.round(share * 100)} %)`
      : "Marker's page: no Docling conversion of its file",
  };
};

export interface KudosRenameOptions {
  /** Each document's earlier numeric ids under its `kudos:` id, as `kudosEarlierIds()` gives them. */
  earlierIds: ReadonlyMap<string, readonly string[]>;
  /** Why a number has no UUID, as the map's `unresolved` says. */
  unresolved?: Readonly<Record<string, string>>;
  /** The page of a source that is renamed, from `kudosPage`. */
  pageOf?: (source: SourceRef) => KudosPage | undefined;
  /** The map, as the provenance names it. */
  map: string;
  /** Where the pages come from, as the provenance names it. */
  pages?: string;
  mappedOn: string;
}

/** A source the rename left as it was, or renamed with a page from Marker, and why. */
export interface ListedSource {
  case: string;
  document: string;
  position?: number;
  reason: string;
}

export interface KudosRename {
  set: TestSet;
  renamed: number;
  listed: ListedSource[];
}

/**
 * A Kudos test set's sources under the ids a copy into the knowledge database gives (#394): each
 * numeric document becomes its `kudos:` id with the number kept as its earlier id, its chunk id is
 * dropped, and it gets the page `pageOf` finds. A number without a UUID, or one the copy does not
 * take for its UUID (of two numbers it copies the higher, as `copyListing` does), stays as it is.
 */
export const renameKudosSources = (set: TestSet, options: KudosRenameOptions): KudosRename => {
  const kudosIdOf = new Map<string, string>();
  const copiedOf = new Map<string, string>();
  for (const [id, numbers] of options.earlierIds)
    for (const n of numbers) {
      kudosIdOf.set(n, id);
      const copied = copiedOf.get(id);
      if (copied === undefined || Number(n) > Number(copied)) copiedOf.set(id, n);
    }
  const listed: ListedSource[] = [];
  let renamed = 0;
  const rename = (caseId: string, source: SourceRef): SourceRef => {
    const n = source.document;
    if (n === undefined || !/^\d+$/.test(n)) return source;
    const list = (reason: string) =>
      listed.push({
        case: caseId,
        document: n,
        ...(source.position === undefined ? {} : { position: source.position }),
        reason,
      });
    const id = kudosIdOf.get(n);
    if (id === undefined) {
      list(options.unresolved?.[n] ?? 'no UUID in the map');
      return source;
    }
    const copied = copiedOf.get(id);
    if (copied !== n) {
      list(`the copy takes ${copied} for ${id}, so this number's text may differ`);
      return source;
    }
    const page = options.pageOf?.(source);
    if (page?.from === 'marker') list(page.reason);
    renamed++;
    return {
      document: id,
      earlierDocument: n,
      ...(source.position === undefined ? {} : { position: source.position }),
      ...(page?.page === undefined ? {} : { page: page.page }),
    };
  };
  const cases = set.spec.cases.map((c) => ({
    ...c,
    expected: { ...c.expected, sources: c.expected.sources.map((s) => rename(c.id, s)) },
  }));
  return {
    set: {
      ...set,
      metadata: { ...set.metadata, version: set.metadata.version + 1 },
      spec: {
        ...set.spec,
        provenance: {
          ...set.spec.provenance,
          ...(options.pageOf
            ? { sourceIdentity: 'document + page; position where a hit has no page' }
            : {}),
          mapping: `renamed to kudos: ids with ${options.map} on ${options.mappedOn}${options.pages ? `; pages ${options.pages}` : ''}`,
          ...(listed.length === 0 ? {} : { listedSources: listed }),
        },
        cases,
      },
    },
    renamed,
    listed,
  };
};
