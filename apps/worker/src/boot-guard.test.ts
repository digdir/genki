import { describe, expect, it } from 'vitest';
import { workerBootProblems } from './boot-guard.js';

describe('booting the worker', () => {
  it('the worker refuses to start without a database unless dev mode is on', () => {
    expect(workerBootProblems({})).toEqual([expect.stringContaining('DATABASE_URL')]);
    expect(workerBootProblems({ GENAI_DEV_MODE: 'false' })).toEqual([
      expect.stringContaining('GENAI_DEV_MODE=true'),
    ]);
    expect(workerBootProblems({ GENAI_DEV_MODE: 'true' })).toEqual([]);
    expect(workerBootProblems({ DATABASE_URL: 'postgres://db/genai' })).toEqual([]);
  });

  it('refuses dev mode in production', () => {
    expect(workerBootProblems({ GENAI_DEV_MODE: 'true', GENAI_ENV: 'production' })).toEqual([
      expect.stringContaining('production'),
    ]);
  });
});
