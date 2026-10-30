import { describe, expect, it } from 'vitest';
import { databaseHosts, knowledgeServerProblems, withoutKnowledgeServer } from './index.js';

const catalog = {
  endpoints: {
    'platform-pg': { engine: 'pgvector', options: {} },
    'knowledge-pg': { engine: 'pgvector', options: { connection: 'knowledge' } },
  },
  datasets: [
    { id: 'digdir/genki-docs', endpoint: 'platform-pg' },
    { id: 'digdir/kudos', endpoint: 'knowledge-pg' },
  ],
};

describe('the knowledge server at boot', () => {
  it('an endpoint set to `knowledge` without a knowledge server is left out with a warning in development mode', () => {
    const warnings: string[] = [];
    expect(withoutKnowledgeServer(catalog, (m) => warnings.push(m))).toEqual({
      endpoints: { 'platform-pg': catalog.endpoints['platform-pg'] },
      datasets: [catalog.datasets[0]],
    });
    expect(warnings).toEqual([expect.stringContaining('knowledge-pg')]);
    expect(knowledgeServerProblems({ GENAI_DEV_MODE: 'true' }, catalog)).toEqual([]);
  });

  it('the egress allow-lists include the knowledge hosts', () => {
    expect(
      databaseHosts({
        DATABASE_URL: 'postgres://genai@127.0.0.1:55432/genai',
        PGHOST: 'platform.postgres.database.azure.com',
        KNOWLEDGE_DATABASE_URL: 'postgres://127.0.0.1:55433/genai_knowledge',
        KNOWLEDGE_PGHOST: 'knowledge.postgres.database.azure.com',
        KNOWLEDGE_READ_PGHOST: 'knowledge-replica.postgres.database.azure.com',
      }),
    ).toEqual([
      '127.0.0.1',
      'platform.postgres.database.azure.com',
      '127.0.0.1',
      'knowledge.postgres.database.azure.com',
      'knowledge-replica.postgres.database.azure.com',
    ]);
  });
});
