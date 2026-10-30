import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, platformId, PostgresAdminRecords } from '@genai/providers-postgres';
import { boundPlatformId } from '@genai/providers-pgvector';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { setUpKnowledge } from './knowledge-server-setup.ts';

let container: StartedPostgreSqlContainer;
let platform: pg.Pool;
let otherPlatform: pg.Pool;
let knowledge: pg.Pool;
const tenant = '991825827';
const logins = { apiLogin: 'genai_knowledge_api', workerLogin: 'genai_knowledge_worker' };

const poolFor = (database: string) => {
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${database}`;
  return new pg.Pool({ connectionString: url.toString() });
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  platform = new pg.Pool({ connectionString: container.getConnectionUri() });
  for (const db of ['other_platform', 'genai_knowledge'])
    await platform.query(`create database ${db}`);
  otherPlatform = poolFor('other_platform');
  knowledge = poolFor('genai_knowledge');
  await migrate(platform);
  await migrate(otherPlatform);
  for (const login of Object.values(logins)) await platform.query(`create role ${login} login`);
}, 120_000);

afterAll(async () => {
  await Promise.all([platform?.end(), otherPlatform?.end(), knowledge?.end()]);
  await stopPostgres(container);
});

describe('the knowledge server setup script', () => {
  it('rebinding stores the new platform id and audits the old id, the new id and the reason', async () => {
    const first = await setUpKnowledge({ platform, knowledge, ...logins, tenant });
    expect(first.outcome).toBe('bound');
    const oldId = await platformId(platform);
    const newId = await platformId(otherPlatform);

    await expect(
      setUpKnowledge({ platform: otherPlatform, knowledge, ...logins, tenant }),
    ).rejects.toThrow('--rebind');
    const reason = 'test gets a copy of production for #132';
    expect(
      await setUpKnowledge({
        platform: otherPlatform,
        knowledge,
        ...logins,
        tenant,
        rebind: { reason },
      }),
    ).toMatchObject({ outcome: 'rebound', platformId: newId, previous: oldId });
    expect(await boundPlatformId(knowledge)).toBe(newId);

    const audit = await (await PostgresAdminRecords.open(otherPlatform)).audit(tenant);
    expect(audit).toEqual([
      expect.objectContaining({
        tenant,
        action: 'platform.knowledge.rebind',
        actor: container.getUsername(),
        outcome: 'applied',
        target: `knowledge server binding: ${oldId} -> ${newId}`,
        reason,
      }),
    ]);
  });
});
