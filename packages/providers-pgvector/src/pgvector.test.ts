import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { envSecrets } from '@genai/kernel';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IndexWriterRouter,
  parseKnowledgeCatalog,
  probeKnowledgeEndpoint,
  type DatasetConfig,
  type DatasetEmbedding,
  type IndexDocument,
  type IndexWriter,
  type IndexWriterAdapter,
  type KnowledgeAdapter,
} from '@genai/port-knowledge';
import {
  fixtureFilters,
  fixtureVector,
  indexWriterContract,
  knowledgeAdapterContract,
  openTarget,
  seedCorpus,
} from '@genai/port-knowledge/testing';
import { fakeEmbedder } from '@genai/port-embedding/testing';
import { pgvectorEngine, type PgvectorEngineOptions, type QueryEmbedder } from './index.js';
import { searchSql } from './sql.js';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}
import { stopPostgres } from '@genai/providers-postgres/testing';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const signal = new AbortController().signal;
const embedding: DatasetEmbedding = { model: 'fixture', dimensions: 32 };
const endpoint = { options: { connection: 'platform' } };

const fixtureEmbedder = (dataset: DatasetConfig): QueryEmbedder => ({
  embed: async (texts) => texts.map((t) => fixtureVector(t, dataset.embedding?.dimensions ?? 0)),
});

const engineWith = (embedder: PgvectorEngineOptions['embedder'] = fixtureEmbedder) =>
  pgvectorEngine({ pool, embedder });

const writerOf = (engine: ReturnType<typeof pgvectorEngine>) =>
  engine.writer.connect(
    { options: { connection: 'platform' }, timeoutMs: 5000 },
    { signal },
  ) as IndexWriter;

const config = (id: string, extra: Partial<DatasetConfig> = {}): DatasetConfig => ({
  id,
  filters: fixtureFilters,
  options: {},
  ...extra,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
});

const seeded =
  (withEmbedding: boolean) =>
  async ({ dataset }: { dataset: { id: string } }) => {
    const engine = engineWith();
    await seedCorpus(writerOf(engine), config(dataset.id, withEmbedding ? { embedding } : {}));
    return {
      adapter: engine.adapter,
      endpoint,
      ...(withEmbedding ? { embedding } : {}),
      failingRequest: { query: 'tilskudd '.repeat(300) },
    };
  };

knowledgeAdapterContract('pgvector', seeded(false));

knowledgeAdapterContract('pgvector with embedding', seeded(true));

indexWriterContract('pgvector', async ({ dataset }) => {
  const engine = engineWith();
  return {
    adapter: engine.adapter,
    endpoint,
    writer: writerOf(engine),
    dataset: { ...dataset, options: {} },
  };
});

indexWriterContract('pgvector with embedding', async ({ dataset }) => {
  const engine = engineWith();
  return {
    adapter: engine.adapter,
    endpoint,
    embedding,
    writer: writerOf(engine),
    dataset: { ...dataset, options: {}, embedding },
  };
});

const single = (
  id: string,
  title: string,
  chunks: string[],
  vectors?: number[][],
): IndexDocument => ({
  id,
  title,
  fields: {},
  chunks: chunks.map((text, position) => ({
    id: `${id}-${position}`,
    position,
    text,
    ...(vectors?.[position] ? { vector: vectors[position] } : {}),
  })),
  phrases: [],
});

const seed = async (writer: IndexWriter, dataset: DatasetConfig, documents: IndexDocument[]) => {
  await writer.prepare(dataset, 'g1');
  for (const doc of documents) await writer.store(dataset, 'g1', doc);
  await writer.promote(dataset, 'g1');
};

describe('pgvector engine', () => {
  it('hybrid ranks an exact phrase match above a merely similar chunk', async () => {
    const dims = { model: 'fixture', dimensions: 3 };
    const engine = engineWith(() => ({ embed: async (texts) => texts.map(() => [1, 0, 0]) }));
    const dataset = config('pgvector/hybrid', { embedding: dims, filters: {} });
    await seed(writerOf(engine), dataset, [
      single('eksakt', 'Eksakt', ['Søknadsfristen for tilskudd er 1. mars.'], [[0.8, 0.6, 0]]),
      single('lignende', 'Lignende', ['Midler kan bes om før våren.'], [[1, 0, 0]]),
      single('annet', 'Annet', ['Rapporter leveres årlig.'], [[0, 0, 1]]),
    ]);
    const port = openTarget({ adapter: engine.adapter, endpoint, embedding: dims }, dataset);
    const { hits } = await port.search({ query: 'søknadsfristen for tilskudd', limit: 3 });
    expect(hits.map((h) => h.document).slice(0, 2)).toEqual(['eksakt', 'lignende']);
  });

  it('a search batch larger than the pool does not fail every request waiting for a connection', async () => {
    const dims = { model: 'fixture', dimensions: 3 };
    const embedder = () => ({ embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) });
    const dataset = config('pgvector/small-pool', { embedding: dims, filters: {} });
    await seed(writerOf(engineWith(embedder)), dataset, [
      single('frist', 'Frist', ['Søknadsfristen for tilskudd er 1. mars.'], [[1, 0, 0]]),
    ]);
    const small = new pg.Pool({
      connectionString: container.getConnectionUri(),
      max: 2,
      connectionTimeoutMillis: 200,
    });
    let slow = false;
    small.on('connect', (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      Object.assign(client, {
        query: async (...args: unknown[]) => {
          if (slow) await new Promise((resolve) => setTimeout(resolve, 50));
          return query(...args);
        },
      });
    });
    try {
      const port = openTarget(
        { adapter: pgvectorEngine({ pool: small, embedder }).adapter, endpoint, embedding: dims },
        dataset,
      );
      await port.search({ query: 'tilskudd' });
      slow = true;
      const results = await port.searchMany(
        Array.from({ length: 10 }, (_, i) => ({ query: `tilskudd ${i}`, limit: 3 })),
      );
      expect(results.map((r) => r.warning)).toEqual(Array(10).fill(undefined));
      expect(results.every((r) => r.hits[0]?.document === 'frist')).toBe(true);
    } finally {
      await small.end();
    }
  });

  it('norwegian text search matches søknad and søknader', async () => {
    const engine = engineWith();
    const dataset = config('pgvector/norsk', { filters: {} });
    await seed(writerOf(engine), dataset, [
      single('entall', 'Entall', ['En søknad om tilskudd.']),
      single('flertall', 'Flertall', ['Alle søknader behandles fortløpende.']),
      single('ingen', 'Ingen', ['Rapporter leveres årlig.']),
    ]);
    const port = openTarget({ adapter: engine.adapter, endpoint }, dataset);
    for (const query of ['søknad', 'søknader']) {
      const { hits } = await port.search({ query, limit: 10 });
      expect(hits.map((h) => h.document).sort(), query).toEqual(['entall', 'flertall']);
    }
  });

  it('datasets are isolated by dataset id', async () => {
    const embedder = fakeEmbedder({ dimensions: 8 });
    const dims = { model: 'fake', dimensions: 8 };
    const engine = engineWith(() => ({
      embed: async (texts) => (await embedder.embed(texts)).vectors,
    }));
    const writer = writerOf(engine);
    const a = config('pgvector/isolert-a', { embedding: dims, filters: {} });
    const b = config('pgvector/isolert-b', { embedding: dims, filters: {} });
    const vectors = [(await embedder.embed(['tilskudd'])).vectors[0] ?? []];
    await seed(writer, a, [single('felles', 'A', ['Tilskudd i datasett A.'], vectors)]);
    await seed(writer, b, [single('felles', 'B', ['Tilskudd i datasett B.'], vectors)]);
    const port = openTarget({ adapter: engine.adapter, endpoint, embedding: dims }, a);
    const { hits } = await port.search({ query: 'tilskudd', limit: 10 });
    expect(hits.map((h) => h.text)).toEqual(['Tilskudd i datasett A.']);
    expect((await port.fetch(['felles-0'])).map((h) => h.title)).toEqual(['A']);
    expect(await port.facets([])).toEqual({});
    await writer.prepare(a, 'g2');
    await expect(writer.drop(b, 'g1')).rejects.toMatchObject({ code: 'bad_request' });
    await writer.drop(a, 'g2');
    expect((await writer.stats(b, 'g1')).documents).toBe(1);
  });

  it('a second pgvector endpoint shares the tables and cannot drop the served generation', async () => {
    const engine = engineWith();
    const writers = new IndexWriterRouter({
      catalog: {
        endpoints: {
          plattform: { engine: 'pgvector', options: { connection: 'platform' } },
          kopi: { engine: 'pgvector', options: { connection: 'platform' } },
        },
        datasets: [{ id: 'pgvector/delt', endpoint: 'plattform', residency: 'norway' }],
      },
      adapters: [engine.writer as IndexWriterAdapter],
      knowledgeAdapters: [engine.adapter as KnowledgeAdapter],
      secrets: envSecrets({}),
    });
    const served = writers.open('pgvector/delt', { signal });
    await seed(served.writer, served.dataset, [single('delt', 'Delt', ['Tilskudd deles.'])]);
    const other = writers.openAt('pgvector/delt', 'kopi', { signal });
    await expect(other.writer.drop(other.dataset, 'g1', { force: true })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(await other.writer.active(other.dataset)).toBe('g1');
    expect((await served.writer.stats(served.dataset, 'g1')).documents).toBe(1);
  });

  it('reports the generation searches read, so a task can record it', async () => {
    const engine = engineWith();
    const writer = writerOf(engine);
    const dataset = config('pgvector/generasjon', { filters: {} });
    const reader = engine.adapter.connect({ ...endpoint, timeoutMs: 5000 } as never);

    expect(await reader.served?.(dataset as never, signal)).toEqual({});
    await seed(writer, dataset, [single('en', 'En', ['Første.'])]);
    expect(await reader.served?.(dataset as never, signal)).toEqual({ generation: 'g1' });
    await writer.prepare(dataset, 'g2');
    await writer.promote(dataset, 'g2');
    expect(await reader.served?.(dataset as never, signal)).toEqual({ generation: 'g2' });
  });

  it('custom profiles search vectors alone and named document fields', async () => {
    const engine = engineWith();
    const datasetOptions = {
      profiles: {
        vektor: { target: 'phrases', mode: 'vector' },
        sammendrag: { target: 'docs', mode: 'text', fields: ['sammendrag', 'title'] },
      },
    };
    const dataset = config('pgvector/profiler', { embedding, options: datasetOptions });
    await seedCorpus(writerOf(engine), dataset);
    const port = openTarget(
      { adapter: engine.adapter, endpoint, embedding, datasetOptions },
      dataset,
    );
    expect(port.info().profiles).toEqual(['vektor', 'sammendrag']);
    const vector = await port.search({ query: 'Kan tilskudd brukes til skyplattform?', limit: 1 });
    expect(vector.hits.map((h) => h.id)).toEqual(['dok-1-2']);
    const fields = await port.search({
      query: 'innovasjon',
      profile: 'sammendrag',
      filters: { aar: { gte: 2024 } },
    });
    expect(fields.hits.map((h) => h.document)).toEqual(['dok-5']);
  });

  describe('searching inside one document', () => {
    const datasetOptions = {
      profiles: {
        content: { target: 'chunks', mode: 'hybrid' },
        mening: { target: 'chunks', mode: 'vector' },
        ord: { target: 'chunks', mode: 'text' },
        setninger: { target: 'phrases', mode: 'hybrid' },
      },
    };
    const dataset = config('pgvector/rapporter', {
      filters: { doc_num: 'multiselect', title: 'text' },
      embedding,
      options: datasetOptions,
    });
    const port = () =>
      openTarget({ adapter: engineWith().adapter, endpoint, embedding, datasetOptions }, dataset);
    const report = (id: string, title: string): IndexDocument => {
      const texts = [`Omorganisering i ${title}`, `Overføring av ansatte i ${title}`];
      return {
        ...single(
          id,
          title,
          texts,
          texts.map((t) => fixtureVector(t, embedding.dimensions)),
        ),
        phrases: texts.map((t, i) => ({ id: `${id}-p${i}`, chunkId: `${id}-${i}`, text: t })),
      };
    };

    beforeAll(async () => {
      await seed(writerOf(engineWith()), dataset, [
        report('kudos:toll-2025', 'Årsrapport Tolletaten 2025'),
        report('kudos:nav-2025', 'Årsrapport NAV 2025'),
        report('kudos:toll-2024', 'Årsrapport Tolletaten 2024'),
      ]);
    });

    it("a doc_num filter returns only that document's chunks", async () => {
      for (const profile of ['content', 'mening', 'ord', 'setninger']) {
        const { hits } = await port().search({
          query: 'omorganisering',
          profile,
          filters: { doc_num: ['kudos:nav-2025'] },
        });
        expect(hits.length, profile).toBeGreaterThan(0);
        expect(new Set(hits.map((h) => h.document)), profile).toEqual(new Set(['kudos:nav-2025']));
      }
    });

    it('a title filter keeps documents whose title holds every word of one option', async () => {
      const documents = async (title: string[]) =>
        new Set(
          (
            await port().search({
              query: 'omorganisering',
              profile: 'ord',
              filters: { title: { contains: title } },
            })
          ).hits.map((h) => h.document),
        );
      expect(await documents(['Årsrapport Tolletaten 2025'])).toEqual(new Set(['kudos:toll-2025']));
      expect(await documents(['Tolletaten 2024', 'NAV'])).toEqual(
        new Set(['kudos:toll-2024', 'kudos:nav-2025']),
      );
    });
  });

  describe('text search', () => {
    const datasetOptions = { profiles: { ord: { target: 'chunks', mode: 'text' } } };
    const dataset = config('pgvector/ord', { filters: {}, options: datasetOptions });
    const port = () =>
      openTarget({ adapter: engineWith().adapter, endpoint, datasetOptions }, dataset);

    beforeAll(async () => {
      await seed(writerOf(engineWith()), dataset, [
        single('alle', 'Alle', ['Kvinners lønn i Helsedirektoratet var 826 000 i 2023']),
        single('noen', 'Noen', ['Lønn for menn i Helsedirektoratet']),
        single('rekke', 'Rekke', ['Lønn som kvinner fikk i vegvesenet']),
      ]);
    });

    it('a quoted phrase in a platform text search ranks the chunks with the words in that order first', async () => {
      const { hits } = await port().search({ query: '"kvinners lønn"', profile: 'ord' });
      expect(hits[0]?.document).toBe('alle');
      expect(hits[0]?.score).toBeGreaterThanOrEqual(1);
      expect(hits.slice(1).every((h) => h.score < 1)).toBe(true);
    });

    it('a platform text search that finds too few chunks with all its words adds those with some of them, after', async () => {
      const { hits } = await port().search({ query: 'lønn Helsedirektoratet', profile: 'ord' });
      expect(
        hits
          .map((h) => h.document)
          .slice(0, 2)
          .sort(),
      ).toEqual(['alle', 'noen']);
      expect(hits.slice(0, 2).every((h) => h.score >= 1)).toBe(true);
      expect(hits.map((h) => h.document)[2]).toBe('rekke');
      expect(hits[2]?.score).toBeLessThan(1);
    });

    it('a platform text search that excludes a word never returns a chunk holding it', async () => {
      const { hits } = await port().search({ query: 'lønn -menn', profile: 'ord' });
      expect(hits.map((h) => h.document).sort()).toEqual(['alle', 'rekke']);
    });

    describe('with more matches than the cap', () => {
      const bulk = config('pgvector/bulk', { filters: {} });
      const planOf = async (target: 'chunks' | 'docs', mode: 'text' | 'hybrid', query: string) => {
        const built = searchSql({
          dataset: { ...bulk, options: {} },
          profile: { target, mode },
          query,
          filters: {},
          limit: 10,
          candidates: 50,
          config: 'norwegian',
          rrfK: 60,
        });
        const { rows } = await pool.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
          `explain (analyze, format json) ${built.sql}`,
          built.values,
        );
        return rows[0]?.['QUERY PLAN'][0].Plan;
      };

      beforeAll(async () => {
        await seed(writerOf(engineWith()), bulk, [single('a', 'A', ['budsjett'])]);
        await pool.query(
          `insert into kn_docs (dataset, generation, id, title, fields, config)
             select 'pgvector/bulk', 'g1', 'mange-' || n, 'Budsjett ' || n, '{}', 'norwegian'
             from generate_series(1, 6000) n`,
        );
        await pool.query(
          `insert into kn_chunks (dataset, generation, id, doc_id, position, text, config)
             select 'pgvector/bulk', 'g1', 'mange-' || n, 'mange-' || n, 0, 'budsjett og regnskap ' || n, 'norwegian'
             from generate_series(1, 6000) n`,
        );
        // Two words in half the chunks each, never in the same one.
        await pool.query(
          `insert into kn_chunks (dataset, generation, id, doc_id, position, text, config)
             select 'pgvector/bulk', 'g1', 'hver-' || n, 'mange-' || (n % 6000 + 1), n,
               case when n % 2 = 0 then 'havneavgift ' else 'kystverket ' end || n, 'norwegian'
             from generate_series(1, 100000) n`,
        );
        await pool.query('analyze kn_docs');
        await pool.query('analyze kn_chunks');
      }, 120_000);

      it('a platform text search ranks at most 5,000 of the chunks it matches', async () => {
        for (const [target, mode, query] of [
          ['chunks', 'hybrid', 'budsjett regnskap'],
          ['chunks', 'text', 'budsjett tjente'],
          ['docs', 'text', 'budsjett'],
        ] as const) {
          const ranked: number[] = [];
          const walk = (node: PlanNode) => {
            // The rows going into the aggregate or sort where ts_rank_cd ranks the matches.
            if (/Aggregate|Sort/.test(node['Node Type']))
              ranked.push(node.Plans?.[0]?.['Actual Rows'] ?? 0);
            node.Plans?.forEach(walk);
          };
          const plan = await planOf(target, mode, query);
          if (plan) walk(plan);
          expect(ranked.length).toBeGreaterThan(0);
          expect(Math.max(...ranked)).toBeLessThanOrEqual(5000);
        }
      });

      it('a platform text search for words common apart but never together reads a small part of the chunks', async () => {
        for (const mode of ['hybrid', 'text'] as const) {
          let read = 0;
          const walk = (node: PlanNode) => {
            if (node['Relation Name'] === 'kn_chunks')
              read +=
                (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) *
                node['Actual Loops'];
            node.Plans?.forEach(walk);
          };
          const plan = await planOf('chunks', mode, 'havneavgift kystverket');
          if (plan) walk(plan);
          // The dataset holds 106,001 chunks; the some-words fallback reads until it has 5,000.
          expect(read).toBeLessThan(15_000);
        }
      });
    });
  });

  describe('a metadata hit', () => {
    const datasetOptions = { profiles: { metadata: { target: 'docs', mode: 'text' } } };
    const dataset = config('pgvector/arsrapporter', { filters: {}, options: datasetOptions });
    const search = async (query: string) =>
      (
        await openTarget(
          { adapter: engineWith().adapter, endpoint, datasetOptions },
          dataset,
        ).search({ query, profile: 'metadata' })
      ).hits;
    const hitOf = async (query: string) =>
      (await search(query)).find((h) => h.document === 'toll')?.id;

    beforeAll(async () => {
      await seed(writerOf(engineWith()), dataset, [
        single('toll', 'Årsrapport Tolletaten 2025', [
          'Årsrapport Tolletaten 2025',
          'Innhold: Leders beretning. Tolletaten i 2025. Regnskap',
          'Tolletaten 2025: tall for 2025, 2025 og 2025 i Tolletaten',
          'I 2025 ble omorganiseringen av Tolletaten fullført',
          'Read this or that, or else, or not',
        ]),
        single('leer', 'Tolletaten omorganisering', []),
      ]);
    });

    it("a metadata hit is the document's chunk that best matches the query", async () => {
      expect(await hitOf('Tolletaten omorganisering')).toBe('toll-3');
    });

    it("a metadata hit falls back to the document's first chunk when no chunk matches", async () => {
      expect(await hitOf('Tolletaten regnskapsprinsipper')).toBe('toll-0');
    });

    it("a metadata hit whose query holds only the title's words is the document's first chunk", async () => {
      // Page 2 holds the title's words most often, but the query names only the document.
      expect(await hitOf('"Årsrapport Tolletaten 2025"')).toBe('toll-0');
    });

    it('a document without chunks does not hide the some-words matches', async () => {
      // `leer` holds every word in its title and has no chunk; Tolletaten 2025 holds some of them.
      expect(await hitOf('Tolletaten omorganisering')).toBe('toll-3');
    });

    it('a metadata hit ignores a word excluded with -', async () => {
      expect(await hitOf('Tolletaten -omorganisering')).toBe('toll-0');
    });

    it('a metadata search lists a document once', async () => {
      // `or` is an operator to the all-words query and a word to the some-words one.
      const hits = await search('Tolletaten or omorganisering');
      expect(hits.filter((h) => h.document === 'toll').map((h) => h.id)).toEqual(['toll-3']);
    });

    it("a metadata hit is chosen by the query words the document's title and fields do not hold", async () => {
      // Page 2 holds the title's words most often; only page 3 holds the word the title lacks.
      expect(await hitOf('"omorganisering" "Årsrapport Tolletaten 2025"')).toBe('toll-3');
    });
  });

  describe('the VACUUM workaround for pgvector 0.8.2', () => {
    const vacuums = async () => {
      await pool.query('select pg_stat_force_next_flush()');
      const { rows } = await pool.query<{ n: number }>(
        `select vacuum_count::int as n from pg_stat_user_tables where relname = 'kn_chunks'`,
      );
      return rows[0]?.n ?? 0;
    };

    it('the shared knowledge tables have autovacuum off', async () => {
      await seed(writerOf(engineWith()), config('pgvector/vacuum-av', { filters: {} }), [
        single('en', 'En', ['Første.']),
      ]);
      const { rows } = await pool.query<{ relname: string; reloptions: string[] | null }>(
        `select relname, reloptions from pg_class
          where relname in ('kn_generations', 'kn_active', 'kn_docs', 'kn_chunks', 'kn_phrases')
          order by relname`,
      );
      expect(rows).toEqual([
        { relname: 'kn_active', reloptions: null },
        { relname: 'kn_chunks', reloptions: ['autovacuum_enabled=false'] },
        { relname: 'kn_docs', reloptions: ['autovacuum_enabled=false'] },
        { relname: 'kn_generations', reloptions: null },
        { relname: 'kn_phrases', reloptions: ['autovacuum_enabled=false'] },
      ]);
    });

    it('each run ends with a VACUUM of the shared knowledge tables', async () => {
      const writer = writerOf(engineWith());
      const dataset = config('pgvector/vacuum-run', { filters: {} });
      await writer.prepare(dataset, 'g1');
      await writer.store(dataset, 'g1', single('en', 'En', ['Første.']));
      const before = await vacuums();
      await writer.promote(dataset, 'g1');
      expect(await vacuums()).toBe(before + 1);
    });

    it('VACUUM never runs while a write to the shared knowledge tables is open', async () => {
      const writer = writerOf(engineWith());
      const dataset = config('pgvector/vacuum-open', { filters: {} });
      await writer.prepare(dataset, 'g1');
      await writer.store(dataset, 'g1', single('en', 'En', ['Første.']));
      const open = await pool.connect();
      try {
        await open.query('begin');
        await open.query(`select pg_advisory_xact_lock_shared(hashtext('genai-knowledge-vacuum'))`);
        const before = await vacuums();
        await writer.promote(dataset, 'g1');
        expect(await vacuums()).toBe(before);
        await open.query('commit');
        await writer.promote(dataset, 'g1');
        expect(await vacuums()).toBe(before + 1);
      } finally {
        open.release();
      }
    });

    it('writes to the shared knowledge tables wait while a VACUUM runs', async () => {
      const writer = writerOf(engineWith());
      const dataset = config('pgvector/vacuum-wait', { filters: {} });
      await seed(writer, dataset, [single('en', 'En', ['Første.'])]);
      await writer.prepare(dataset, 'g2');
      const vacuuming = await pool.connect();
      const waits = async (write: () => Promise<unknown>) => {
        await vacuuming.query(`select pg_advisory_lock(hashtext('genai-knowledge-vacuum'))`);
        let done = false;
        const writing = write().then(() => {
          done = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const waited = !done;
        await vacuuming.query(`select pg_advisory_unlock(hashtext('genai-knowledge-vacuum'))`);
        await writing;
        return waited;
      };
      try {
        expect(await waits(() => writer.store(dataset, 'g2', single('to', 'To', ['Andre.'])))).toBe(
          true,
        );
        expect(await waits(() => writer.drop(dataset, 'g2'))).toBe(true);
      } finally {
        vacuuming.release();
      }
    });

    it('a drop is followed by a VACUUM of the shared knowledge tables', async () => {
      const writer = writerOf(engineWith());
      const dataset = config('pgvector/vacuum-drop', { filters: {} });
      await seed(writer, dataset, [single('en', 'En', ['Første.'])]);
      await writer.prepare(dataset, 'g2');
      await writer.store(dataset, 'g2', single('to', 'To', ['Andre.']));
      const before = await vacuums();
      await writer.drop(dataset, 'g2');
      expect(await vacuums()).toBe(before + 1);
    });

    it('a failed VACUUM is reported, and leaves the run promoted and the lock free', async () => {
      const failures: unknown[] = [];
      const writer = writerOf(pgvectorEngine({ pool, onVacuumError: (e) => failures.push(e) }));
      const dataset = config('pgvector/vacuum-fails', { filters: {} });
      await writer.prepare(dataset, 'g1');
      await writer.store(dataset, 'g1', single('en', 'En', ['Første.']));
      await pool.query(`alter table kn_phrases rename to kn_phrases_away`);
      try {
        await writer.promote(dataset, 'g1');
      } finally {
        await pool.query(`alter table kn_phrases_away rename to kn_phrases`);
      }
      expect(await writer.active(dataset)).toBe('g1');
      expect(failures).toHaveLength(1);
      const writerSession = new pg.Client({ connectionString: container.getConnectionUri() });
      await writerSession.connect();
      try {
        const { rows } = await writerSession.query<{ free: boolean }>(
          `select pg_try_advisory_xact_lock_shared(hashtext('genai-knowledge-vacuum')) as free`,
        );
        expect(rows[0]?.free).toBe(true);
      } finally {
        await writerSession.end();
      }
      const before = await vacuums();
      await writer.promote(dataset, 'g1');
      expect(await vacuums()).toBe(before + 1);
    });
  });

  it('an endpoint with an external connection is refused', () => {
    const { adapter } = engineWith();
    const result = parseKnowledgeCatalog(
      {
        endpoints: {
          ekstern: {
            engine: 'pgvector',
            options: { connection: 'postgres://bruker:hemmelig@db.example.no/kunnskap' },
          },
        },
        datasets: [],
      },
      [adapter],
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('endpoints.ekstern.options.connection');
  });

  it('probe succeeds on a reachable endpoint and fails clearly otherwise', async () => {
    const probe = (engine: ReturnType<typeof pgvectorEngine>) =>
      probeKnowledgeEndpoint(
        { engine: 'pgvector' },
        { adapters: [engine.adapter], secrets: envSecrets({}), timeoutMs: 5000 },
      );
    expect(await probe(engineWith())).toMatchObject({ ok: true, engine: 'pgvector' });
    const unreachable = new pg.Pool({
      connectionString: 'postgres://ingen:ingen@127.0.0.1:1/ingen',
      connectionTimeoutMillis: 2000,
    });
    try {
      expect(await probe(pgvectorEngine({ pool: unreachable }))).toMatchObject({
        ok: false,
        code: 'unavailable',
        message: expect.stringMatching(/ECONNREFUSED|connect/),
      });
    } finally {
      await unreachable.end();
    }
  });
});
