import {
  KnowledgeError,
  tombstoneHash,
  type CitationResolution,
  type CitationStatus,
  type DatasetConfig,
  type DatasetEmbedding,
  type FacetValue,
  type Hit,
  type KnowledgeConnection,
  type SearchRequest,
  type SearchResult,
} from '@genai/port-knowledge';
import type { Pool, PoolClient } from 'pg';
import { filterRows, notReadyCode } from './read-functions.js';
import type { Profile } from './sql.js';

interface HitRow {
  id: string;
  text: string;
  doc_id: string;
  position: number;
  metadata: Record<string, unknown>;
  title: string | null;
  url: string | null;
  fields: Record<string, unknown>;
  score: number | null;
  total: number | null;
}

/** Every read function's rows carry the generation's data version on the server that answered (bigint, as text). */
type Versioned<R> = R & { data_version: string };

interface CitationRow {
  cited: string;
  status: CitationStatus;
  document: string | null;
  title: string | null;
  url: string | null;
  withdrawn_on: string | null;
}

interface Recipe {
  embedding?: DatasetEmbedding;
  textSearchConfig?: string;
}

export interface KnowledgeReadOptions<D> {
  /** The pool on `KNOWLEDGE_READ_PGHOST`; when it is the primary's, nothing is read twice. */
  read?: Pool | undefined;
  primary: Pool;
  timeoutMs: number;
  profilesOf(dataset: DatasetConfig<D>): [string, Profile][];
  rrfK(dataset: DatasetConfig<D>): number;
  /** Plans and runs a batch of searches; the engine shares this with `connection: platform`. */
  searchBatch(
    dataset: DatasetConfig<D>,
    requests: SearchRequest[],
    signal: AbortSignal,
    one: (
      p: Profile,
      request: SearchRequest,
      vector: number[] | undefined,
    ) => Promise<SearchResult>,
  ): Promise<SearchResult[]>;
}

const sqlState = /^[0-9A-Z]{5}$/;

const isNotReady = (error: unknown) => (error as { code?: string }).code === notReadyCode;

/** A replica that does not answer: no connection, or a connection lost or shut down mid-read. */
const unreachable = (error: unknown) => {
  const code = (error as { code?: string }).code;
  if (code === undefined || !sqlState.test(code)) return true;
  return code.startsWith('08') || ['57P01', '57P02', '57P03'].includes(code);
};

const failIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
};

const hitOf = (row: HitRow): Hit => ({
  id: row.id,
  score: row.score ?? 0,
  text: row.text,
  ...(row.title === null ? {} : { title: row.title }),
  ...(row.url === null ? {} : { url: row.url }),
  document: row.doc_id,
  position: row.position,
  fields: { ...row.fields, ...row.metadata },
});

/** Reads a dataset on the knowledge server only through its read functions, as the reader. */
export const knowledgeReads = <D>(
  options: KnowledgeReadOptions<D>,
): Omit<KnowledgeConnection<D>, 'profiles'> => {
  const { primary } = options;
  const read = options.read === primary ? undefined : options.read;
  const recipes = new Map<string, Recipe>();
  // Keyed by the dataset config the router hands each read and then `served`, so one port's reads never report another's.
  const answered = new WeakMap<DatasetConfig<D>, number>();

  const attempt = async <T>(
    pool: Pool,
    allowed: string[],
    vectors: boolean,
    run: (client: PoolClient) => Promise<T>,
  ) => {
    const client = await pool.connect();
    let broken: unknown;
    try {
      await client.query('begin transaction read only');
      await client.query(
        `select set_config('statement_timeout', $1, true), set_config('app.datasets', $2, true)${vectors ? `, set_config('hnsw.iterative_scan', 'relaxed_order', true)` : ''}`,
        [String(Math.max(1, Math.trunc(options.timeoutMs))), JSON.stringify(allowed)],
      );
      const result = await run(client);
      await client.query('commit');
      return result;
    } catch (error) {
      if (unreachable(error)) broken = error;
      else await client.query('rollback').catch((e: unknown) => (broken = e));
      throw error;
    } finally {
      client.release(broken instanceof Error ? broken : undefined);
    }
  };

  /** A read host that did not answer is left alone this long, so each read does not wait for it again. */
  const skipReadMs = 30_000;
  let readSkippedUntil = 0;

  const refused = (error: unknown, dataset: DatasetConfig<D>) =>
    (error as { code?: string }).code === '42501'
      ? new KnowledgeError('forbidden', `dataset ${dataset.id} is not allowed`)
      : error;

  /** Read pool first; a server without the generation or one that does not answer sends the read to the primary, whose answer is final. */
  const reading = async <T>(
    dataset: DatasetConfig<D>,
    signal: AbortSignal,
    empty: T,
    run: (client: PoolClient, generation: string) => Promise<T>,
    vectors = false,
  ): Promise<T> => {
    failIfAborted(signal);
    const allowed = dataset.allowed;
    if (!allowed?.includes(dataset.id))
      throw new KnowledgeError(
        'forbidden',
        `dataset ${dataset.id} is read only through the knowledge router`,
      );
    const generation = dataset.generation;
    if (generation === undefined) return empty;
    const go = (client: PoolClient) => run(client, generation);
    if (read && Date.now() >= readSkippedUntil) {
      try {
        return await attempt(read, allowed, vectors, go);
      } catch (error) {
        failIfAborted(signal);
        if (unreachable(error)) readSkippedUntil = Date.now() + skipReadMs;
        else if (!isNotReady(error)) throw refused(error, dataset);
      }
    }
    try {
      return await attempt(primary, allowed, vectors, go);
    } catch (error) {
      failIfAborted(signal);
      if (isNotReady(error)) return empty;
      throw refused(error, dataset);
    }
  };

  const recipe = async (dataset: DatasetConfig<D>, signal: AbortSignal) => {
    const generation = dataset.generation;
    const known = generation === undefined ? undefined : recipes.get(generation);
    if (known) return known;
    const found = await reading<Recipe | undefined>(dataset, signal, undefined, async (c, g) => {
      const { rows } = await c.query<{ recipe: Recipe }>(`select kn_generation($1, $2) as recipe`, [
        dataset.id,
        g,
      ]);
      return rows[0]?.recipe;
    });
    // A generation's recipe is written once, when it is prepared.
    if (found && generation !== undefined) recipes.set(generation, found);
    return found;
  };

  /** Runs one read function and keeps the data version of the server whose rows it returns, asking that server when there are none. */
  const versioned = async <R extends object>(
    dataset: DatasetConfig<D>,
    signal: AbortSignal,
    sql: string,
    values: (g: string) => unknown[],
    vectors = false,
  ): Promise<R[]> => {
    const answer = await reading(
      dataset,
      signal,
      undefined,
      async (c, g) => {
        const { rows } = await c.query<Versioned<R>>(sql, values(g));
        const version =
          rows[0]?.data_version ??
          (
            await c.query<{ version: string | null }>(
              `select kn_generation($1, $2)->>'dataVersion' as version`,
              [dataset.id, g],
            )
          ).rows[0]?.version;
        return { rows, version: version == null ? undefined : Number(version) };
      },
      vectors,
    );
    if (answer?.version !== undefined) answered.set(dataset, answer.version);
    return answer?.rows ?? [];
  };

  const hits = (rows: HitRow[]) => rows.map(hitOf);

  return {
    served: async (dataset) => {
      if (!dataset.generation) return {};
      const dataVersion = answered.get(dataset);
      return {
        generation: dataset.generation,
        ...(dataVersion === undefined ? {} : { dataVersion }),
      };
    },
    search: async (dataset, requests, signal) => {
      const built = await recipe(dataset, signal);
      if (!built) return requests.map(() => ({ hits: [], found: 0 }));
      // The query is embedded with the model the generation was built with, not the catalog's current one.
      const asBuilt: DatasetConfig<D> = {
        ...dataset,
        ...(built.embedding ? { embedding: built.embedding } : {}),
      };
      return options.searchBatch(asBuilt, requests, signal, async (p, request, vector) => {
        const limit = request.limit ?? 10;
        const rows = await versioned<HitRow>(
          dataset,
          signal,
          `select * from kn_search($1, $2, $3, $4, $5, $6::halfvec, $7::text[], $8::jsonb, $9, $10, $11)`,
          (g) => [
            dataset.id,
            g,
            p.target,
            p.mode,
            request.query,
            vector === undefined ? null : JSON.stringify(vector),
            p.fields ?? null,
            JSON.stringify(filterRows(dataset, request.filters)),
            limit,
            Math.max(limit * 4, 50),
            options.rrfK(dataset),
          ],
          vector !== undefined,
        );
        return { hits: hits(rows), found: rows[0]?.total ?? 0 };
      });
    },
    fetch: async (dataset, ids, signal) => {
      const rows = await versioned<HitRow>(
        dataset,
        signal,
        `select * from kn_fetch($1, $2, $3::text[])`,
        (g) => [dataset.id, g, ids],
      );
      const byId = new Map(rows.map((r) => [r.id, hitOf(r)]));
      return ids.flatMap((id) => byId.get(id) ?? []);
    },
    range: async (dataset, document, from, to, signal) =>
      hits(
        await versioned<HitRow>(
          dataset,
          signal,
          `select * from kn_range($1, $2, $3, $4, $5)`,
          (g) => [dataset.id, g, document, from, to],
        ),
      ),
    facets: async (dataset, fields, filters, signal) => {
      const rows = await versioned<{ field: string; value: string; count: number }>(
        dataset,
        signal,
        `select * from kn_facets($1, $2, $3::text[], $4::jsonb)`,
        (g) => [dataset.id, g, fields, JSON.stringify(filterRows(dataset, filters))],
      );
      const result: Record<string, FacetValue[]> = Object.fromEntries(fields.map((f) => [f, []]));
      for (const row of rows) result[row.field]?.push({ value: row.value, count: row.count });
      return result;
    },
    documents: async (dataset, request, signal) => {
      const rows = await versioned<{
        id: string | null;
        title: string | null;
        url: string | null;
        fields: Record<string, unknown>;
        total: number;
      }>(
        dataset,
        signal,
        `select * from kn_documents($1, $2, $3::text[], $4::jsonb, $5, $6)`,
        (g) => [
          dataset.id,
          g,
          request.ids ?? null,
          JSON.stringify(filterRows(dataset, request.filters)),
          request.limit ?? 100,
          request.offset ?? 0,
        ],
      );
      // A page past the end is one row with no id that still carries the count.
      return {
        documents: rows
          .flatMap((r) => (r.id === null ? [] : [{ ...r, id: r.id }]))
          .map((r) => ({
            id: r.id,
            ...(r.title === null ? {} : { title: r.title }),
            ...(r.url === null ? {} : { url: r.url }),
            fields: r.fields,
          })),
        found: rows[0]?.total ?? 0,
      };
    },
    resolveCitations: async (dataset, ids, signal) => {
      const rows = await versioned<CitationRow>(
        dataset,
        signal,
        `select cited, status, document, title, url, withdrawn_on::text, data_version
           from kn_resolve_citation($1, $2, $3::text[], $4::text[])`,
        (g) => [dataset.id, g, ids, ids.map((id) => tombstoneHash(dataset.id, id))],
      );
      const byId = new Map(rows.map((r) => [r.cited, r]));
      return ids.map((cited): CitationResolution => {
        const row = byId.get(cited);
        if (!row) return { cited, status: 'unknown' };
        return {
          cited,
          status: row.status,
          ...(row.document === null ? {} : { document: row.document }),
          ...(row.title === null ? {} : { title: row.title }),
          ...(row.url === null ? {} : { url: row.url }),
          ...(row.withdrawn_on === null ? {} : { withdrawnOn: row.withdrawn_on }),
        };
      });
    },
  };
};
