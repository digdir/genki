import { knowledgeDropQueue, type Job } from '@genai/jobs';
import type { DatasetConfig } from '@genai/port-knowledge';
import {
  attachGeneration,
  knowledgeHeavyWork,
  migrateKnowledgeServer,
  openKnowledgePools,
  prepareGeneration,
  setUpKnowledgeServer,
} from '@genai/providers-pgvector';
import { createPool } from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropWork, wholeDatasetDropMessage } from './knowledge-drop.js';

const ORG = '991825827';

let container: StartedPostgreSqlContainer;
let admin: ReturnType<typeof createPool>;
let knowledgeServer: ReturnType<typeof openKnowledgePools>;
const owner = () => knowledgeServer.pools.owner as ReturnType<typeof createPool>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  admin = createPool({ connectionString: container.getConnectionUri() });
  for (const login of ['knowledge_api', 'knowledge_worker'])
    await admin.query(`create role ${login} login password 'login-pw'`);
  await setUpKnowledgeServer(admin, {
    apiLogin: 'knowledge_api',
    workerLogin: 'knowledge_worker',
    platformId: '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
  });
  knowledgeServer = openKnowledgePools(
    {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'knowledge_worker',
      password: 'login-pw',
    },
    'worker',
  );
  await migrateKnowledgeServer(owner());
}, 120_000);

afterAll(async () => {
  await knowledgeServer?.close();
  await admin?.end();
  await stopPostgres(container);
});

const dataset = (id: string, generation?: string): DatasetConfig => ({
  id,
  filters: {},
  options: {},
  ...(generation ? { generation } : {}),
});

const work = (catalog: DatasetConfig[]) => {
  const heavy = knowledgeHeavyWork(owner());
  return dropWork({ datasets: () => catalog, server: heavy });
};

const job = (data: Job<{ tenant: string; dataset: string; generation?: string }>['data']) =>
  ({
    id: crypto.randomUUID(),
    queue: knowledgeDropQueue.name,
    data,
    retryCount: 0,
    signal: new AbortController().signal,
  }) as Job<never>;

const exists = async (generation: string) =>
  (await admin.query(`select 1 from kn_generations where generation = $1`, [generation]))
    .rowCount === 1;

describe('knowledge.drop', () => {
  it("a cancelled switch's generation is dropped by a drop job", async () => {
    const id = `${ORG}/switched`;
    for (const generation of ['g-20261104-aaaaaa', 'g-20261104-bbbbbb'])
      await prepareGeneration(owner(), dataset(id), generation);
    await attachGeneration(owner(), dataset(id), 'g-20261104-bbbbbb');
    // The catalog still names the previous engine: neither generation is active.
    const handler = work([]).handler;
    await handler(job({ tenant: ORG, dataset: id, generation: 'g-20261104-aaaaaa' }));
    await handler(job({ tenant: ORG, dataset: id, generation: 'g-20261104-bbbbbb' }));
    expect(await exists('g-20261104-aaaaaa')).toBe(false);
    expect(await exists('g-20261104-bbbbbb')).toBe(false);
    const { rows } = await admin.query(
      `select relname from pg_class where relname like 'kn\\_%\\_g\\_%'`,
    );
    expect(rows).toEqual([]);
    // Run twice, it finds nothing left and ends.
    await handler(job({ tenant: ORG, dataset: id, generation: 'g-20261104-aaaaaa' }));
  }, 60_000);

  it('a drop job refuses a generation the catalog names as active', async () => {
    const id = `${ORG}/active`;
    await prepareGeneration(owner(), dataset(id), 'g-20261104-cccccc');
    const handler = work([dataset(id, 'g-20261104-cccccc')]).handler;
    await expect(
      handler(job({ tenant: ORG, dataset: id, generation: 'g-20261104-cccccc' })),
    ).rejects.toThrow(/active generation/);
    // Nor one that belongs to another dataset.
    await expect(
      work([]).handler(
        job({ tenant: ORG, dataset: `${ORG}/other`, generation: 'g-20261104-cccccc' }),
      ),
    ).rejects.toThrow(/belongs to/);
    await expect(work([]).handler(job({ tenant: ORG, dataset: id }))).rejects.toThrow(
      wholeDatasetDropMessage,
    );
    expect(await exists('g-20261104-cccccc')).toBe(true);
  }, 60_000);
});
