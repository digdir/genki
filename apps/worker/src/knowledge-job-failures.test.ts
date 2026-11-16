import {
  InMemoryJobQueue,
  knowledgeBuildQueue,
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

/** PostgreSQL's error for U+0000 in text, as node-postgres throws it. */
const nulError = () =>
  Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
    name: 'error',
    code: '22021',
  });

/** The worker's job queues in memory, with a clock the test moves past each retry delay. */
const workerJobs = async (error: () => Error) => {
  let now = new Date('2026-11-13T10:00:00Z');
  const opened: InMemoryJobQueue[] = [];
  const logged: { msg: string; fields: Record<string, unknown> }[] = [];
  const ran: string[] = [];
  const failing = (queue: string) => async () => {
    ran.push(queue);
    throw error();
  };
  const jobs = await openWorkerJobs<object>({
    platform: { owner: {}, worker: {} },
    knowledge: { owner: {}, writer: {} },
    markerTimeoutMs: 60_000,
    work: [queueWork(platformQueue, failing(platformQueue.name))],
    knowledgeWork: [
      queueWork(knowledgeSeedQueue, failing(knowledgeSeedQueue.name)),
      queueWork(knowledgeBuildQueue, failing(knowledgeBuildQueue.name)),
    ],
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
    ran,
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

/** Waits for each attempt's log line, moving the clock past the retry delay after each. */
const attempts = async (w: Awaited<ReturnType<typeof workerJobs>>, count: number) => {
  for (let attempt = 1; attempt <= count; attempt += 1) {
    await vi.waitFor(() => expect(w.logged.length).toBeGreaterThanOrEqual(attempt));
    w.later();
  }
};

describe('failed knowledge jobs', () => {
  it('a knowledge job that fails is logged with its queue and error', async () => {
    const w = await workerJobs(nulError);
    const knowledge = w.jobs.knowledge as JobQueue;
    const id = await knowledge.send(knowledgeSeedQueue, seedBatch);

    await attempts(w, knowledgeSeedQueue.retryLimit + 1);

    const line = (attempt: number, next: string) => ({
      msg: 'a knowledge job failed',
      fields: { queue: 'knowledge.seed', job: id, attempt, next, error: 'error', code: '22021' },
    });
    expect(w.logged).toEqual([line(1, 'retry'), line(2, 'retry'), line(3, 'dead letter')]);
    expect(await knowledge.deadLetters(knowledgeSeedQueue)).toHaveLength(1);
    await w.stop();
  });

  it('the last attempt of a knowledge job without dead letters is logged as followed by nothing', async () => {
    const w = await workerJobs(nulError);
    await w.jobs.knowledge?.send(knowledgeBuildQueue, {
      tenant: 'platform',
      generation: 'g20261113',
      kind: 'vacuum',
    });

    await attempts(w, knowledgeBuildQueue.retryLimit + 1);

    expect(w.logged.map((l) => [l.fields.queue, l.fields.attempt, l.fields.next])).toEqual([
      ['knowledge.build', 1, 'retry'],
      ['knowledge.build', 2, 'none'],
    ]);
    await w.stop();
  });

  it('a failed knowledge job logs no file path or URL', async () => {
    const w = await workerJobs(() =>
      Object.assign(
        new Error(
          "ENOENT: no such file or directory, open '/data/konv-2/permisjon-ola-nordmann.md'",
        ),
        { code: 'ENOENT' },
      ),
    );
    await w.jobs.knowledge?.send(knowledgeSeedQueue, seedBatch);

    await vi.waitFor(() => expect(w.logged).toHaveLength(1));

    expect(w.logged[0]?.fields).toMatchObject({ error: 'Error', code: 'ENOENT' });
    expect(JSON.stringify(w.logged)).not.toMatch(/permisjon|konv-2|\/data/);
    await w.stop();
  });

  it('a failing job outside the knowledge queues is not logged as a knowledge job', async () => {
    const w = await workerJobs(() => new Error('the evaluation failed'));
    await w.jobs.platform.send(platformQueue, seedBatch);
    await w.jobs.knowledge?.send(knowledgeSeedQueue, seedBatch);

    await vi.waitFor(() => expect(w.ran).toContain(platformQueue.name));
    await vi.waitFor(() => expect(w.logged).toHaveLength(1));

    expect(w.logged.map((l) => l.fields.queue)).toEqual(['knowledge.seed']);
    await w.stop();
  });
});
