import type { IngestionExecution } from '@genai/providers-postgres';
import { describe, expect, it } from 'vitest';
import { replacementRuns } from './knowledge-handlers.js';

const now = new Date('2026-11-18T10:00:00Z');
const ended = (overrides: Partial<IngestionExecution> = {}): IngestionExecution => ({
  id: 'run-1',
  dataset: '991825827/kudos',
  pipeline: 'kudos',
  pipelineVersion: 1,
  backend: 'index-writer',
  status: 'succeeded',
  startedBy: 'test',
  startedAt: '2026-11-18T03:00:00Z',
  runsAsJobs: true,
  admittedAt: '2026-11-18T03:00:00Z',
  ...overrides,
});

const sender = (lockdown = false) => {
  const started: string[] = [];
  const send = replacementRuns({
    conversions: {
      replaceable: async () => [{ record: '1', files: [{ name: 'a', sha256: 'a'.repeat(64) }] }],
      short: async () => [],
    },
    runs: {
      startReplacement: async (from) => {
        started.push(from.id);
        return { ...from, id: 'replacement', status: 'running', replaces: from.id };
      },
    },
    knowledge: { send: async () => 'job' },
    lockdown,
    now: () => now,
  });
  return { send, started };
};

describe('which runs send a replacement run', () => {
  it('a cancelled run, a copy and a replacement run send no replacement run', async () => {
    const { send, started } = sender();
    expect(await send(ended({ status: 'cancelled' }))).toBeUndefined();
    expect(await send(ended({ pipeline: '_copy' }))).toBeUndefined();
    expect(await send(ended({ replaces: 'run-0' }))).toBeUndefined();
    expect(started).toEqual([]);
    expect((await send(ended()))?.replaces).toBe('run-1');
  });

  it('in lockdown, only a run admitted within 24 hours sends one', async () => {
    const { send, started } = sender(true);
    expect(await send(ended({ admittedAt: '2026-11-17T09:00:00Z' }))).toBeUndefined();
    expect(started).toEqual([]);
    expect(await send(ended({ admittedAt: '2026-11-17T11:00:00Z' }))).toBeDefined();
  });
});
