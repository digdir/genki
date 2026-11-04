import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresApiKeys } from './api-keys.js';

const row = {
  id: 'key-ka',
  name: 'Kunnskapsassistenten',
  digest: '0'.repeat(64),
  tenant: '991825827',
  scopes: ['query'],
  dataset_grants: ['*'],
  agent_grants: ['*'],
  client_id: null,
  service: null,
  allowed_overrides: null,
  calls_per_minute: 120,
  skill_graph_grants: [],
  allowed_config_keys: [],
  policy_id: null,
  admitted_in_lockdown: false,
  created_at: new Date('2026-10-01T08:00:00Z'),
  last_used_at: new Date('2026-11-03T13:02:00Z'),
  usage_count: '1234',
  revoked_at: null,
  expires_at: null,
};

const poolReturning = (rows: unknown[]) => {
  const query = async (sql: string) => ({ rows: /select \*/.test(sql) ? rows : [] });
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
};

describe('PostgresApiKeys row mapping', () => {
  it('lists a key with when it was made, when it was last used and how many calls it has had', async () => {
    const [key] = await new PostgresApiKeys(poolReturning([row])).list('991825827');

    expect(key).toMatchObject({
      createdAt: '2026-10-01T08:00:00.000Z',
      lastUsedAt: '2026-11-03T13:02:00.000Z',
      usageCount: 1234,
    });
  });

  it('reads the count Postgres sends as text for a bigint as a number', async () => {
    const [key] = await new PostgresApiKeys(
      poolReturning([{ ...row, last_used_at: null, usage_count: '0' }]),
    ).list('991825827');

    expect(key?.usageCount).toBe(0);
    expect(key).not.toHaveProperty('lastUsedAt');
  });
});
