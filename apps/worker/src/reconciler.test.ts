import type { RunJobs } from '@genai/jobs';
import type { IngestionExecution } from '@genai/providers-postgres';
import { describe, expect, it } from 'vitest';
import { reconcileKnowledgeRuns, type ReconcilerRecords } from './reconciler.js';

const run: IngestionExecution = {
  id: 'r-1',
  dataset: '991825827/kudos',
  pipeline: 'kudos',
  pipelineVersion: 1,
  backend: 'index-writer',
  status: 'running',
  startedBy: 'employee:test:kari',
  startedAt: '2026-11-02T10:00:00.000Z',
  runsAsJobs: true,
  admittedAt: '2026-11-02T10:00:00.000Z',
};

const server = (open: () => Promise<number>): RunJobs => ({
  open,
  deadLetters: async () => ({}),
  cancel: async () => 0,
  redrive: async () => 0,
  runs: async () => [run.id],
});

describe('the knowledge reconciler', () => {
  it("counts a run's jobs on the platform server before the knowledge server", async () => {
    // The ingest job hands over: it sends its index job on the knowledge server, then completes.
    const state = { ingestActive: true, indexJobs: 0 };
    const platform = server(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return state.ingestActive ? 1 : 0;
    });
    const knowledge = server(async () => {
      const counted = state.indexJobs;
      state.indexJobs = 1;
      state.ingestActive = false;
      return counted;
    });
    const ended: string[] = [];
    const records: ReconcilerRecords = {
      open: async () => [run],
      find: async () => run,
      requests: async () => [],
      applied: async () => undefined,
      end: async (r) => {
        ended.push(r.id);
        return { ended: r };
      },
      startQueued: async () => undefined,
    };
    await reconcileKnowledgeRuns({ records, servers: [platform, knowledge], lockdown: false });
    expect(ended).toEqual([]);
  });
});
