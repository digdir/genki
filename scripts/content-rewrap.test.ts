import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createPostgresStores,
  LocalKeyWrapper,
  withPlatformAccess,
} from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { platformLoginFrom } from '../apps/api/src/platform-login.ts';
import { parseRewrapArgs, platformLoginSubjectKeyFrom, runRewrap } from './content-rewrap.ts';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
const first = randomBytes(32);
const second = randomBytes(32);
const lost = randomBytes(32);

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  const stores = await createPostgresStores(pool, new LocalKeyWrapper(first));
  await stores.close();
  await stores.runtimePool.end();
  const rows = [
    ['old-1', await new LocalKeyWrapper(first).wrap(randomBytes(32))],
    ['old-2', await new LocalKeyWrapper(first).wrap(randomBytes(32))],
    ['lost', await new LocalKeyWrapper([{ version: 3, key: lost }]).wrap(randomBytes(32))],
  ] as const;
  await withPlatformAccess(pool, 'test', async (client) => {
    for (const [scope, wrapped] of rows)
      await client.query('insert into content_keys (tenant, scope, wrapped) values ($1, $2, $3)', [
        '991825827',
        scope,
        wrapped,
      ]);
  });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
});

describe('the content re-wrap script', () => {
  it('takes only --dry-run, --batch-size and --platform-login-subject-key', () => {
    expect(parseRewrapArgs([])).toEqual({
      dryRun: false,
      batchSize: 500,
      platformLoginSubjectKey: false,
    });
    expect(parseRewrapArgs(['--dry-run', '--batch-size=20'])).toEqual({
      dryRun: true,
      batchSize: 20,
      platformLoginSubjectKey: false,
    });
    expect(parseRewrapArgs(['--platform-login-subject-key']).platformLoginSubjectKey).toBe(true);
    expect(() => parseRewrapArgs(['--batch-size=0'])).toThrow('--batch-size');
    expect(() => parseRewrapArgs(['--to=1'])).toThrow('unknown argument');
  });

  it('prints the subject key the platform login derives from the master key, never the master key', async () => {
    const env = { CONTENT_MASTER_KEY: first.toString('base64') };
    const lines: string[] = [];
    expect(await runRewrap(['--platform-login-subject-key'], env, (line) => lines.push(line))).toBe(
      0,
    );
    expect(lines).toEqual([platformLoginSubjectKeyFrom(env)]);
    expect(lines.join('\n')).not.toContain(first.toString('base64'));
    const login = { PLATFORM_LOGIN_CLIENT_ID: 'c', PLATFORM_LOGIN_HOSTNAME: 'login.example.no' };
    expect(
      platformLoginFrom({ ...login, PLATFORM_LOGIN_SUBJECT_KEY: lines[0] }, 'digdir:genai')
        ?.subjectKey,
    ).toEqual(platformLoginFrom({ ...login, ...env }, 'digdir:genai')?.subjectKey);
    expect(() => platformLoginSubjectKeyFrom({})).toThrow('CONTENT_MASTER_KEY');
  });

  it('never writes key material, and fails when a key cannot be opened', async () => {
    const env = {
      DATABASE_URL: container.getConnectionUri(),
      CONTENT_MASTER_KEY: first.toString('base64'),
      CONTENT_MASTER_KEY_2: second.toString('base64'),
    };
    const console = ['log', 'error', 'warn', 'info', 'debug'].map((method) =>
      vi.spyOn(globalThis.console, method as 'log').mockImplementation(() => undefined),
    );
    const lines: string[] = [];
    try {
      expect(await runRewrap(['--dry-run'], env, (line) => lines.push(line))).toBe(1);
      expect(await runRewrap([], env, (line) => lines.push(line))).toBe(1);
    } finally {
      for (const spy of console) spy.mockRestore();
    }
    const written = [
      ...lines,
      ...console.flatMap((spy) => spy.mock.calls.map((call) => call.join(' '))),
    ].join('\n');
    for (const key of [first, second, lost]) {
      expect(written).not.toContain(key.toString('base64'));
      expect(written).not.toContain(key.toString('hex'));
    }
    const done = lines.filter((line) => line.includes('"done"')).map((line) => JSON.parse(line));
    expect(done.map((d) => [d.dryRun, d.rewrapped, d.failed])).toEqual([
      [true, 0, 1],
      [false, 2, 1],
    ]);
  });
});
