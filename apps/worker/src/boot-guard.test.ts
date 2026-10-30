import { describe, expect, it } from 'vitest';
import { knowledgeServerProblems, workerBootProblems } from './boot-guard.js';

describe('booting the worker', () => {
  it('the worker refuses to start without a database unless dev mode is on', () => {
    expect(workerBootProblems({})).toEqual([expect.stringContaining('DATABASE_URL')]);
    expect(workerBootProblems({ GENAI_DEV_MODE: 'false' })).toEqual([
      expect.stringContaining('GENAI_DEV_MODE=true'),
    ]);
    expect(workerBootProblems({ GENAI_DEV_MODE: 'true' })).toEqual([]);
    expect(workerBootProblems({ DATABASE_URL: 'postgres://db/genai' })).toEqual([]);
  });

  it('accepts PGHOST for Entra ID login in place of DATABASE_URL', () => {
    expect(workerBootProblems({ PGHOST: 'genki-test-pg.postgres.database.azure.com' })).toEqual([]);
  });

  it('the worker refuses to start with a malformed PLATFORM_TENANT, also in dev mode', () => {
    expect(workerBootProblems({ GENAI_DEV_MODE: 'true', PLATFORM_TENANT: '12345' })).toEqual([
      expect.stringContaining('PLATFORM_TENANT'),
    ]);
  });

  it('refuses dev mode in production', () => {
    expect(workerBootProblems({ GENAI_DEV_MODE: 'true', GENAI_ENV: 'production' })).toEqual([
      expect.stringContaining('production'),
    ]);
  });

  it('an endpoint set to `knowledge` without a knowledge server stops the worker outside development mode', () => {
    const catalog = {
      endpoints: { 'knowledge-pg': { engine: 'pgvector', options: { connection: 'knowledge' } } },
      datasets: [],
    };
    expect(knowledgeServerProblems({ DATABASE_URL: 'postgres://db/genai' }, catalog)).toEqual([
      expect.stringContaining('KNOWLEDGE_PGHOST'),
    ]);
    expect(knowledgeServerProblems({ GENAI_DEV_MODE: 'true' }, catalog)).toEqual([]);
  });
});
