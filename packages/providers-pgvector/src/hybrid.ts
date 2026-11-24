import type { Hit, SearchRequest, SearchResult } from '@genai/port-knowledge';
import type { Profile } from './sql.js';

/** How long the text half of a hybrid search may run before its vector hits come back alone. */
export const textSearchMs = 5000;

/** One half of a hybrid search: its candidate list, and a shorter statement limit for the text half. */
export interface SearchHalf {
  candidates: number;
  timeoutMs?: number;
}

export type SearchOne = (
  p: Profile,
  request: SearchRequest,
  vector: number[] | undefined,
  half?: SearchHalf,
) => Promise<SearchResult>;

/** The candidates each half of a search ranks, as the SQL has always taken them. */
export const candidatesFor = (limit: number) => Math.max(limit * 4, 50);

/** Reciprocal rank fusion as `kn_search` does it in SQL: `1 / (k + rank)` per list, ranks from 1. */
export const rrfMerge = (lists: Hit[][], k: number, limit: number): SearchResult => {
  const merged = new Map<string, { hit: Hit; score: number }>();
  for (const list of lists)
    list.forEach((hit, i) => {
      const known = merged.get(hit.id);
      const score = (known?.score ?? 0) + 1 / (k + i + 1);
      merged.set(hit.id, { hit: known?.hit ?? hit, score });
    });
  const ranked = [...merged.values()].sort(
    (a, b) => b.score - a.score || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0),
  );
  return {
    hits: ranked.slice(0, limit).map(({ hit, score }) => ({ ...hit, score })),
    found: merged.size,
  };
};

// A raw statement timeout from Postgres, or the knowledge database's KnowledgeError for it.
const timedOut = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === '57014' || code === 'timeout';
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A hybrid search as two statements, so a slow or failed half leaves the other's hits and a warning. */
export const searchHybrid = async (
  one: SearchOne,
  p: Profile,
  request: SearchRequest,
  vector: number[],
  rrfK: number,
  textMs: number,
): Promise<SearchResult> => {
  const limit = request.limit ?? 10;
  const candidates = candidatesFor(limit);
  const [text, near] = await Promise.allSettled([
    one(p, request, undefined, { candidates, timeoutMs: textMs }),
    one({ ...p, mode: 'vector' }, request, vector, { candidates }),
  ]);
  if (text.status === 'rejected' && near.status === 'rejected') throw text.reason;
  if (text.status === 'rejected')
    return {
      ...rrfMerge([(near as PromiseFulfilledResult<SearchResult>).value.hits], rrfK, limit),
      warning: `text search ${
        timedOut(text.reason)
          ? `took longer than ${textMs / 1000} s`
          : `failed: ${messageOf(text.reason)}`
      }; these hits come from vector search only`,
    };
  if (near.status === 'rejected')
    return {
      ...rrfMerge([text.value.hits], rrfK, limit),
      warning: `vector search failed: ${messageOf(near.reason)}; these hits come from text search only`,
    };
  return rrfMerge([text.value.hits, near.value.hits], rrfK, limit);
};
