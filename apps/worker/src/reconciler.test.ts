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

  const records = (calls: string[]): ReconcilerRecords => ({
    open: async () => [run],
    find: async () => run,
    requests: async () => [],
    applied: async () => undefined,
    end: async (r) => {
      calls.push(`end ${r.id}`);
      return { ended: r };
    },
    startQueued: async () => undefined,
  });

  it('a run ends with VACUUM (ANALYZE) before it is marked finished', async () => {
    const calls: string[] = [];
    await reconcileKnowledgeRuns({
      records: records(calls),
      servers: [server(async () => 0)],
      lockdown: false,
      finishing: async (r) => {
        calls.push(`vacuum ${r.id}`);
        return true;
      },
    });
    expect(calls).toEqual(['vacuum r-1', 'end r-1']);
  });

  it("a heavy run's VACUUM (ANALYZE) is a build job that keeps the run open until it ends", async () => {
    const calls: string[] = [];
    // The first pass sends the build job; the second sees it open; the third finds it ended.
    const open = [0, 1, 0];
    let pass = 0;
    const finishing = async () => {
      calls.push(`finishing ${pass}`);
      return pass === 2;
    };
    for (pass = 0; pass < 3; pass += 1)
      await reconcileKnowledgeRuns({
        records: records(calls),
        servers: [server(async () => open[pass] ?? 0)],
        lockdown: false,
        finishing,
      });
    expect(calls).toEqual(['finishing 0', 'finishing 2', 'end r-1']);
  });

  it('a cancelled run keeps its VACUUM build job', async () => {
    const cancels: (string[] | undefined)[] = [];
    const cancelled = { ...run, cancelRequestedAt: '2026-11-02T11:00:00.000Z' };
    await reconcileKnowledgeRuns({
      records: { ...records([]), open: async () => [cancelled], find: async () => cancelled },
      servers: [
        {
          ...server(async () => 1),
          cancel: async (_run, options) => {
            cancels.push(options?.except);
            return 0;
          },
        },
      ],
      lockdown: false,
    });
    expect(cancels[0]).toEqual(['knowledge.build']);
  });

  it("a cancelled run's VACUUM build job survives a whole pass", async () => {
    const cancelled = { ...run, cancelRequestedAt: '2026-11-02T11:00:00.000Z' };
    // One waiting job of the run: its VACUUM on the knowledge server.
    let jobs = [{ run: run.id, queue: 'knowledge.build' }];
    const knowledge: RunJobs = {
      open: async (id) => jobs.filter((j) => j.run === id).length,
      deadLetters: async () => ({}),
      cancel: async (id, options) => {
        const before = jobs.length;
        jobs = jobs.filter((j) => j.run !== id || options?.except?.includes(j.queue));
        return before - jobs.length;
      },
      redrive: async () => 0,
      runs: async () => [...new Set(jobs.map((j) => j.run))],
    };
    await reconcileKnowledgeRuns({
      records: { ...records([]), open: async () => [cancelled], find: async () => cancelled },
      servers: [knowledge],
      lockdown: false,
    });
    expect(jobs).toEqual([{ run: run.id, queue: 'knowledge.build' }]);
  });
});
