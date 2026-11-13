import {
  InMemoryJobQueue,
  knowledgeSeedQueue,
  queueWork,
  type JobQueue,
  type QueueDefinition,
  type RunJobs,
} from '@genai/jobs';
import { describe, expect, it, vi } from 'vitest';
import { openWorkerJobs } from './knowledge-jobs.js';

const platformQueue = {
  ...knowledgeSeedQueue,
  name: 'evaluation.run',
} as unknown as QueueDefinition;

const runJobs = () => ({}) as RunJobs;

/** The worker's job queues in memory, with a clock the test moves past each retry delay. */
const workerJobs = async (fail: string) => {
  let now = new Date('2026-11-13T10:00:00Z');
  const opened: InMemoryJobQueue[] = [];
  const logged: { msg: string; fields: Record<string, unknown> }[] = [];
  const failing = async () => {
    throw new Error(fail);
  };
  const jobs = await openWorkerJobs<object>({
    platform: { owner: {}, worker: {} },
    knowledge: { owner: {}, writer: {} },
    markerTimeoutMs: 60_000,
    work: [queueWork(platformQueue, failing)],
    knowledgeWork: [queueWork(knowledgeSeedQueue, failing)],
    open: async () => {
      const queue = new InMemoryJobQueue({ now: () => now, pollMs: 10 });
      opened.push(queue);
      return queue;
    },
    runJobs,
    log: (msg, fields) => logged.push({ msg, fields }),
  });
  return {
    jobs,
    logged,
    later: () => {
      now = new Date(now.getTime() + 3_600_000);
    },
    stop: () => Promise.all(opened.map((q) => q.stop())),
  };
};

const seedBatch = {
  tenant: 'platform',
  prefix: '01',
  converter: 'docling',
  version: '2.123.1',
  settings: 'b48834151e40e32998687534cdd32f6cfce37fe3672d96f76c235f50fdff3f6f',
};

describe('failed knowledge jobs', () => {
  it('a knowledge job that fails is logged with its queue and error', async () => {
    const w = await workerJobs('invalid byte sequence for encoding "UTF8": 0x00');
    const knowledge = w.jobs.knowledge as JobQueue;
    const id = await knowledge.send(knowledgeSeedQueue, seedBatch);

    for (let attempt = 1; attempt <= knowledgeSeedQueue.retryLimit + 1; attempt += 1) {
      await vi.waitFor(() => expect(w.logged).toHaveLength(attempt));
      w.later();
    }

    expect(w.logged).toEqual([
      ...Array.from({ length: knowledgeSeedQueue.retryLimit }, (_, i) => ({
        msg: 'a knowledge job failed',
        fields: {
          queue: 'knowledge.seed',
          job: id,
          attempt: i + 1,
          next: 'retry',
          error: 'invalid byte sequence for encoding "UTF8": 0x00',
        },
      })),
      {
        msg: 'a knowledge job failed',
        fields: {
          queue: 'knowledge.seed',
          job: id,
          attempt: knowledgeSeedQueue.retryLimit + 1,
          next: 'dead letter',
          error: 'invalid byte sequence for encoding "UTF8": 0x00',
        },
      },
    ]);
    expect(await knowledge.deadLetters(knowledgeSeedQueue)).toHaveLength(1);
    await w.stop();
  });

  it('a failing job outside the knowledge queues is not logged as a knowledge job', async () => {
    const w = await workerJobs('the evaluation failed');
    await w.jobs.platform.send(platformQueue, seedBatch);
    await w.jobs.knowledge?.send(knowledgeSeedQueue, seedBatch);

    await vi.waitFor(() => expect(w.logged).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(w.logged.map((l) => l.fields.queue)).toEqual(['knowledge.seed']);
    await w.stop();
  });
});
