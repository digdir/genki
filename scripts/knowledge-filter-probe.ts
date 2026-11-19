// Measures filtered vector search on the knowledge server against exact search (issue 800). In Azure:
//   az containerapp exec -g <resource group> -n genai-<env>-worker --command "node scripts/knowledge-filter-probe.ts <command> <generation> [plan.json]"
//
//   sizes <generation>               chunks and documents per `type` and `concerned_years` value, and the server's
//                                    search settings.
//   recall <generation> <plan.json>  recall@k of each side against exact search under the same filter, short lists,
//                                    and first-run and repeat p50/p95 times.
//
// Both are read only: they run as the worker's owner role in read-only transactions, at the server's work_mem unless
// the plan sets one. Prints one JSON line per result. The query draws are issue 674's probe's, so its seeds repeat.
import { readFile } from 'node:fs/promises';
import { knowledgeSourceFromEnv } from '@genai/providers-postgres';
import { openKnowledgePools, partitionOf } from '@genai/providers-pgvector';
import type { PoolClient } from 'pg';

const usage = 'node scripts/knowledge-filter-probe.ts sizes|recall <generation> [plan.json]';
const [command, generation, file] = process.argv.slice(2);

const print = (value: unknown) => console.log(JSON.stringify(value));
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const quantile = (values: number[], q: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(
    (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(1),
  );
};
const mean = (values: number[]) =>
  values.length === 0
    ? null
    : Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4));
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** A small seeded generator, so a bootstrap gives the same interval on every run. */
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The 2.5 and 97.5 percentiles of the mean over queries drawn again with replacement. */
const bootstrapCi = (values: number[], resamples = 10_000, seed = 674) => {
  const n = values.length;
  if (n === 0) return null;
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += values[Math.floor(random() * n)] ?? 0;
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  const at = (q: number) => Number((means[Math.floor(q * (resamples - 1))] ?? 0).toFixed(4));
  return [at(0.025), at(0.975)];
};

interface SampleSpec {
  sample: number;
  /** Percent of the partition's pages `tablesample system` reads. */
  percent?: number;
  seed?: number;
}

/**
 * A side is one way to search: `kn_search` as deployed (its own count, threshold and settings), today's index
 * search with the given limits, or exact search ranked by score, as `kn_search` ranks a small filter.
 */
interface Side {
  name: string;
  search: 'kn_search' | 'index' | 'exact';
  efSearch?: number;
  maxScanTuples?: number;
  scanMemMultiplier?: number;
}

interface Plan extends SampleSpec {
  /** Samples whose vectors are left out, such as an earlier run's. */
  exclude?: SampleSpec[];
  /** Real questions instead of sampled vectors: a JSON file of `{ id, vector }`. */
  queriesFile?: string;
  /** Earlier output with the same query vectors and filters: its exact lists are used, not searched again. */
  exactFile?: string[];
  /** Only the queries `exactFile` holds a list for: exact search over a large filter can take minutes a query. */
  knownOnly?: boolean;
  /** Print each query's plan for the first question (no search runs), instead of measuring. */
  explainOnly?: boolean;
  candidates: number;
  k: number;
  /** Unset: the server's own, as search runs. */
  workMem?: string;
  filters: { name: string; filters: unknown }[];
  sides: Side[];
}

const main = async () => {
  if (!command || !generation || !/^g-[0-9a-z-]+$/.test(generation)) throw new Error(usage);
  const source = knowledgeSourceFromEnv(process.env, 'worker');
  if (!source) throw new Error('set KNOWLEDGE_PGHOST, or KNOWLEDGE_DATABASE_URL locally');
  const { pools, close } = openKnowledgePools({ ...source, max: 2 }, 'worker');
  const owner = pools.owner;
  if (!owner) throw new Error('the worker login has no owner pool');
  const chunks = partitionOf('kn_chunks', generation);
  const docs = partitionOf('kn_docs', generation);

  const readOnly = async <T>(run: (c: PoolClient) => Promise<T>) => {
    const client = await owner.connect();
    try {
      await client.query('begin transaction read only');
      await client.query(`set local statement_timeout = 0`);
      return await run(client);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release(true);
    }
  };

  const recipeOf = async (c: PoolClient) => {
    const { rows } = await c.query<{ dataset: string; dims: number | null; cfg: string | null }>(
      `select dataset, (recipe -> 'embedding' ->> 'dimensions')::int as dims, recipe ->> 'textSearchConfig' as cfg
         from kn_generations where generation = $1`,
      [generation],
    );
    const found = rows[0];
    if (!found?.dims) throw new Error(`generation ${generation} is unknown or holds no vectors`);
    return { dataset: found.dataset, dims: found.dims, cfg: found.cfg ?? 'norwegian' };
  };

  const settingNames = [
    'work_mem',
    'hnsw.ef_search',
    'hnsw.iterative_scan',
    'hnsw.max_scan_tuples',
    'hnsw.scan_mem_multiplier',
  ];
  const settingsOf = async (c: PoolClient) =>
    Object.fromEntries(
      (
        await c.query<{ name: string; value: string | null }>(
          `select n as name, current_setting(n, true) as value from unnest($1::text[]) n`,
          [settingNames],
        )
      ).rows.map((r) => [r.name, r.value]),
    );

  try {
    if (command === 'sizes') {
      await readOnly(async (c) => {
        await c.query(`select '[1]'::vector`); // loads pgvector, so its settings read as the server's
        print({ generation, settings: await settingsOf(c) });
        const { rows } = await c.query(
          `with v as (
             select d.id, f.k as field, e #>> '{}' as value from ${docs} d
             cross join lateral jsonb_each(d.fields) f(k, j)
             cross join lateral jsonb_array_elements(case jsonb_typeof(j) when 'array' then j else jsonb_build_array(j) end) e
             where f.k in ('type', 'concerned_years'))
           select v.field, v.value, count(distinct v.id)::int as docs, count(c.id)::int as chunks
             from v join ${chunks} c on c.generation = ${literal(generation)} and c.doc_id = v.id
             group by 1, 2 order by 1, 4 desc`,
        );
        for (const row of rows) print(row);
      });
    } else if (command === 'recall') {
      const plan: Plan = JSON.parse(await readFile(file ?? '', 'utf8'));
      await readOnly(async (c) => {
        const { dataset, dims, cfg } = await recipeOf(c);
        const ds = literal(dataset);
        const g = literal(generation);
        if (plan.workMem) await c.query(`select set_config('work_mem', $1, true)`, [plan.workMem]);
        await c.query(`select '[1]'::vector`); // loads pgvector, so its settings read as the server's
        await c.query(`set local hnsw.iterative_scan = relaxed_order`);
        const server = await settingsOf(c);
        print({ settings: server });

        const draw = (s: SampleSpec) =>
          `select id, vec::text as vec from ${chunks} tablesample system (${Number(s.percent ?? 0.05)})
             repeatable (${Math.trunc(Number(s.seed ?? 674))}) where vec is not null order by md5(id) limit ${Math.trunc(s.sample)}`;
        const excluded = new Set<string>();
        for (const e of plan.exclude ?? [])
          for (const r of (await c.query<{ id: string }>(draw(e))).rows) excluded.add(r.id);
        const queries: { id: string; vec: string }[] = plan.queriesFile
          ? (
              JSON.parse(await readFile(plan.queriesFile, 'utf8')) as {
                id: string;
                vector: number[];
              }[]
            ).map((q) => ({ id: q.id, vec: `[${q.vector.join(',')}]` }))
          : (
              await c.query<{ id: string; vec: string }>(
                draw({ ...plan, sample: plan.sample + excluded.size }),
              )
            ).rows
              .filter((q) => !excluded.has(q.id))
              .slice(0, plan.sample);
        print({ queries: queries.length, seed: plan.seed, percent: plan.percent });

        const stored = new Map<string, string[]>();
        for (const path of plan.exactFile ?? [])
          for (const line of (await readFile(path, 'utf8')).split('\n')) {
            if (!line.startsWith('{"filter"') || !line.includes('"exact"')) continue;
            const row = JSON.parse(line) as { filter: string; id: string; exact?: string[] };
            if (row.exact) stored.set(`${row.filter}\u0000${row.id}`, row.exact);
          }

        const dist = (n = 1) => `x.vec::halfvec(${dims}) <=> $${n}::halfvec(${dims})`;
        const from = (where: string) =>
          `from kn_chunks x join kn_docs d on d.dataset = ${ds} and d.generation = ${g} and d.id = x.doc_id
             where x.dataset = ${ds} and x.generation = ${g} and x.vec is not null and ${where}`;
        // An exact ranking reads the filter's documents first, then each one's chunks by the doc index, as
        // `kn_search` does: joined plainly, the planner may rank every chunk of the generation before filtering.
        const exactFrom = (where: string) =>
          where === 'true'
            ? from(where)
            : `from (select d.id from kn_docs d where d.dataset = ${ds} and d.generation = ${g} and ${where}) m
                 cross join lateral (select x.id, x.vec from kn_chunks x where x.dataset = ${ds}
                   and x.generation = ${g} and x.doc_id = m.id and x.vec is not null offset 0) x`;
        const truthSql = (where: string) =>
          `select n.id from (select x.id, (1 - (${dist()}))::float8 as s ${exactFrom(where)}) n
             order by n.s desc, n.id limit ${plan.k}`;
        const sideSql = (side: Side, where: string) => {
          if (side.search === 'exact')
            return `select n.id from (select x.id, (1 - (${dist()}))::float8 as s ${exactFrom(where)}
               order by s desc, x.id limit ${plan.candidates}) n order by n.s desc, n.id`;
          return `select n.id from (select x.id, ${dist()} as d ${from(where)}
             order by ${dist()} limit ${plan.candidates}) n order by n.d, n.id`;
        };
        const sideSettings = (side: Side) =>
          c.query(
            `select set_config('hnsw.ef_search', $1, true), set_config('hnsw.max_scan_tuples', $2, true),
                    set_config('hnsw.scan_mem_multiplier', $3, true)`,
            [
              String(side.efSearch ?? server['hnsw.ef_search']),
              String(side.maxScanTuples ?? server['hnsw.max_scan_tuples']),
              String(side.scanMemMultiplier ?? server['hnsw.scan_mem_multiplier']),
            ],
          );
        const reset = () =>
          c.query(
            `select set_config('hnsw.ef_search', $1, true), set_config('hnsw.max_scan_tuples', $2, true),
                    set_config('hnsw.scan_mem_multiplier', $3, true)`,
            [
              server['hnsw.ef_search'],
              server['hnsw.max_scan_tuples'],
              server['hnsw.scan_mem_multiplier'],
            ],
          );

        for (const f of plan.filters) {
          const where =
            f.filters == null
              ? 'true'
              : ((
                  await c.query<{ sql: string }>(`select kn_filter_sql($1::jsonb, $2) as sql`, [
                    JSON.stringify(f.filters),
                    cfg,
                  ])
                ).rows[0]?.sql ?? 'false');
          // Truth: every distance under the filter computed. Ordered by score, as `kn_search` ranks a small filter,
          // so the HNSW index cannot serve it and the filter's own indexes still can.
          const asked = plan.knownOnly
            ? queries.filter((q) => stored.has(`${f.name}\u0000${q.id}`))
            : queries;
          if (plan.explainOnly) {
            const q = asked[0];
            if (!q) continue;
            const show = async (name: string, sql: string) =>
              print({
                filter: f.name,
                explain: name,
                plan: (await c.query<{ 'QUERY PLAN': string }>(`explain ${sql}`, [q.vec])).rows.map(
                  (r) => r['QUERY PLAN'],
                ),
              });
            await show('truth', truthSql(where));
            for (const side of plan.sides) {
              if (side.search === 'kn_search') continue;
              await sideSettings(side);
              await show(side.name, sideSql(side, where));
            }
            await reset();
            continue;
          }
          const truth = new Map<string, string[]>();
          for (const q of asked) {
            const known = stored.get(`${f.name}\u0000${q.id}`);
            if (known) truth.set(q.id, known.slice(0, plan.k));
            else {
              const start = process.hrtime.bigint();
              const { rows } = await c.query<{ id: string }>(truthSql(where), [q.vec]);
              truth.set(
                q.id,
                rows.map((r) => r.id),
              );
              print({
                filter: f.name,
                id: q.id,
                exact: truth.get(q.id),
                ms: Number(ms(start).toFixed(1)),
              });
            }
          }

          const run = async (side: Side, vec: string) => {
            await reset();
            if (side.search === 'kn_search') {
              const start = process.hrtime.bigint();
              const { rows } = await c.query<{ sql: string }>(
                `select kn_search_sql($1, $2, 'chunks', 'vector', '', $3::halfvec, null, $4::jsonb, $5, $5, 60) as sql`,
                [
                  dataset,
                  generation,
                  vec,
                  f.filters == null ? '[]' : JSON.stringify(f.filters),
                  plan.candidates,
                ],
              );
              const hits = await c.query<{ id: string; score: number }>(rows[0]?.sql ?? '');
              const effective = await settingsOf(c);
              return {
                ids: hits.rows.map((r) => r.id),
                took: ms(start),
                ef: effective['hnsw.ef_search'],
              };
            }
            await sideSettings(side);
            const start = process.hrtime.bigint();
            const { rows } = await c.query<{ id: string }>(sideSql(side, where), [vec]);
            return { ids: rows.map((r) => r.id), took: ms(start), ef: null };
          };

          const results = plan.sides.map((side) => ({
            side,
            recall: [] as number[],
            short: 0,
            first: [] as number[],
            repeat: [] as number[],
            exactPath: 0,
          }));
          for (const [i, q] of asked.entries()) {
            const exact = truth.get(q.id) ?? [];
            // Sides take turns going first, so no side always finds the pages cached.
            const order = results.map((_, j) => results[(i + j) % results.length]);
            for (const pass of ['first', 'repeat'] as const)
              for (const r of order) {
                if (!r) continue;
                const got = await run(r.side, q.vec);
                r[pass].push(got.took);
                if (pass === 'repeat') continue;
                const top = new Set(got.ids.slice(0, plan.k));
                if (exact.length)
                  r.recall.push(exact.filter((id) => top.has(id)).length / exact.length);
                // A short list holds fewer than the candidates asked for, though more match (the exact list is full).
                if (got.ids.length < plan.candidates && exact.length === plan.k) r.short += 1;
                if (got.ef === server['hnsw.ef_search'] && f.filters != null) r.exactPath += 1;
              }
          }
          for (const r of results)
            print({
              filter: f.name,
              side: r.side.name,
              search: r.side.search,
              settings: r.side.search === 'kn_search' ? 'its own' : r.side,
              queries: r.recall.length,
              [`recall@${plan.k}`]: { mean: mean(r.recall), ci95: bootstrapCi(r.recall) },
              shortLists: r.short,
              ...(r.side.search === 'kn_search' ? { serverSettingsKept: r.exactPath } : {}),
              firstMs: { p50: quantile(r.first, 0.5), p95: quantile(r.first, 0.95) },
              repeatMs: { p50: quantile(r.repeat, 0.5), p95: quantile(r.repeat, 0.95) },
            });
        }
      });
    } else throw new Error(usage);
  } finally {
    await close();
  }
};

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
