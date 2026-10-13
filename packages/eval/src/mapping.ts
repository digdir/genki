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
