import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { stopPostgres, waitForNoClients } from './index.js';

describe('stopPostgres', () => {
  it('stops the container only after every client connection is closed', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const uri = container.getConnectionUri();
    const pools = [new pg.Pool({ connectionString: uri }), new pg.Pool({ connectionString: uri })];
    await Promise.all(pools.map((p) => Promise.all([p.query('select 1'), p.query('select 1')])));
    const errors: unknown[] = [];
    const onUncaught = (error: unknown) => errors.push(error);
    process.on('uncaughtException', onUncaught);
    let clientsLeft = -1;
    const watched = {
      getConnectionUri: () => uri,
      stop: async () => {
        const probe = new pg.Client({ connectionString: uri });
        await probe.connect();
        const { rows } = await probe.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'`,
        );
        clientsLeft = rows[0]?.n ?? -1;
        await probe.end();
        return container.stop();
      },
    };
    try {
      await stopPostgres(watched, pools);
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    expect(clientsLeft).toBe(0);
    expect(errors).toEqual([]);
  }, 120_000);

  it('gives up waiting after the timeout instead of hanging', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    const held = new pg.Client({ connectionString: container.getConnectionUri() });
    held.on('error', () => undefined);
    await held.connect();
    try {
      expect(await waitForNoClients(container.getConnectionUri(), 200)).toBe(false);
    } finally {
      await held.end();
      await stopPostgres(container);
    }
  }, 120_000);
});
