import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { pgvectorConversionStore, pgvectorEmbeddingCache } from './index.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  // The pgvector version Azure Database for PostgreSQL runs
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
});

const conversion = (version: string, markdown: string) => ({
  sha256: 'a1'.repeat(32),
  producer: 'marker',
  version,
  settings: { languages: 'no,en', paginate_output: true },
  markdown,
  output: { pages: ['\n\n{0}', `\n\n${markdown}`], json: { block_type: 'Document', children: [] } },
});

describe('stored conversions in Postgres', () => {
  it('finds the newest conversion of a file by its producer, and replaces one saved again', async () => {
    const store = pgvectorConversionStore(pool);

    await store.save(conversion('1.10.2', 'Gammel tekst.'));
    await store.save(conversion('1.11.0', 'Ny tekst.'));
    await store.save(conversion('1.11.0', 'Ny tekst, rettet.'));

    expect(await store.latest('a1'.repeat(32), 'marker')).toEqual(
      conversion('1.11.0', 'Ny tekst, rettet.'),
    );
    expect(await store.latest('a1'.repeat(32), 'docling')).toBeUndefined();
    expect(await store.latest('b2'.repeat(32), 'marker')).toBeUndefined();
  });
});

describe('cached embeddings in Postgres', () => {
  it('finds vectors by model, size and text hash, at halfvec precision', async () => {
    const cache = pgvectorEmbeddingCache(pool);
    const vector = [0.31622776601683794, -0.9486832980505138, 0, 0];

    await cache.save('foundry/text-embedding-3-large', 4, [{ hash: 'h1', vector }]);
    const found = await cache.find('foundry/text-embedding-3-large', 4, ['h1', 'h2']);

    expect([...found.keys()]).toEqual(['h1']);
    found.get('h1')?.forEach((value, i) => expect(value).toBeCloseTo(vector[i] ?? 0, 3));
    expect((await cache.find('foundry/text-embedding-3-large', 8, ['h1'])).size).toBe(0);
    expect((await cache.find('foundry/text-embedding-3-small', 4, ['h1'])).size).toBe(0);
  });
});
