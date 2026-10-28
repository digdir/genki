import { describe, expect, it } from 'vitest';
import { workerBootProblems, workerBootWarnings } from './boot-guard.js';

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

  it('warns outside dev mode when search data would share the platform database', () => {
    expect(workerBootWarnings({ PGHOST: 'genki-test-pg.postgres.database.azure.com' })).toEqual([
      expect.stringContaining('KNOWLEDGE_DATABASE_URL'),
    ]);
    expect(
      workerBootWarnings({
        DATABASE_URL: 'postgres://db/genai',
        KNOWLEDGE_DATABASE_URL: 'postgres://knowledge/genai',
      }),
    ).toEqual([]);
    expect(
      workerBootWarnings({ GENAI_DEV_MODE: 'true', DATABASE_URL: 'postgres://db/genai' }),
    ).toEqual([]);
  });
});
