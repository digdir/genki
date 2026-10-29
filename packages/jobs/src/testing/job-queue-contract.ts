import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  defineQueue,
  JobQueueError,
  type DeadLetterFilter,
  type JobQueue,
  type JobTransaction,
  type QueueDefinition,
} from '../job-queue.js';

export interface OpenTransaction {
  transaction: JobTransaction;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface JobQueueTarget {
  queue: JobQueue;
  transaction(): Promise<OpenTransaction>;
  withPlatformAccess<T>(read: (transaction?: JobTransaction) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

const payload = z.strictObject({ tenant: z.string().regex(/^\d{9}$/), item: z.string() });

type Payload = z.infer<typeof payload>;

const contractQueue = (name: string, overrides: Partial<QueueDefinition<Payload>> = {}) =>
  defineQueue<Payload>({
    name: `contract.${name}`,
    policy: 'standard',
    payload,
    expireInSeconds: 60,
    heartbeatSeconds: 10,
    retryLimit: 0,
    deadLetter: true,
    ...overrides,
  });

export const contractQueues = {
  plain: contractQueue('plain'),
  transactional: contractQueue('transactional'),
  failing: contractQueue('failing', { retryLimit: 1 }),
  redriven: contractQueue('redriven'),
  tenants: contractQueue('tenants'),
  cancelled: contractQueue('cancelled'),
  keyed: contractQueue('keyed', { policy: 'short' }),
  prioritised: contractQueue('prioritised'),
};

export const waitFor = async <T>(
  read: () => Promise<T> | T,
  timeoutMs = 15_000,
): Promise<NonNullable<T>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ORG_A = '991825827';
const ORG_B = '889640782';

export const describeJobQueueContract = (
  name: string,
  open: (queues: QueueDefinition[]) => Promise<JobQueueTarget>,
) =>
  describe(`job queue contract: ${name}`, () => {
    let target: JobQueueTarget;
    const q = contractQueues;

    const deadLetters = (queue: QueueDefinition, filter: DeadLetterFilter = {}) =>
      target.withPlatformAccess((transaction) =>
        target.queue.deadLetters(queue, { ...filter, ...(transaction ? { transaction } : {}) }),
      );
    const counts = (queues: QueueDefinition[]) =>
      target.withPlatformAccess((transaction) =>
        target.queue.counts(queues, transaction ? { transaction } : {}),
      );

    beforeAll(async () => {
      target = await open(Object.values(contractQueues));
    }, 60_000);

    afterAll(async () => {
      await target?.queue.stop();
      await target?.close?.();
    });

    it('a queue refuses a payload its schema does not admit', async () => {
      await expect(
        target.queue.send(q.plain, {
          tenant: ORG_A,
          item: 'a',
          text: 'the whole document',
        } as Payload),
      ).rejects.toThrow(JobQueueError);
      await expect(target.queue.send(q.plain, { tenant: 'acme', item: 'a' })).rejects.toThrow(
        JobQueueError,
      );
    });

    it('job payloads hold no content', async () => {
      const title = { tenant: ORG_A, item: 'Årsrapport 2023 for Digitaliseringsdirektoratet' };
      await expect(target.queue.send(q.plain, title)).rejects.toThrow(/keys, never content/);
      await expect(
        target.queue.send(q.plain, { tenant: ORG_A, item: 'x'.repeat(129) }),
      ).rejects.toThrow(/keys, never content/);
    });

    it('works a sent job once with its data', async () => {
      const seen: string[] = [];
      await target.queue.work(q.plain, async (job) => {
        seen.push(`${job.data.tenant}/${job.data.item}`);
      });
      await target.queue.send(q.plain, { tenant: ORG_A, item: 'once' });
      await waitFor(() => seen.length === 1);
      await pause(1_000);
      expect(seen).toEqual([`${ORG_A}/once`]);
    });

    it('a job sent in a rolled-back transaction does not exist', async () => {
      const rolledBack = await target.transaction();
      await target.queue.send(
        q.transactional,
        { tenant: ORG_A, item: 'rolled-back' },
        { transaction: rolledBack.transaction },
      );
      await rolledBack.rollback();
      const committed = await target.transaction();
      await target.queue.send(
        q.transactional,
        { tenant: ORG_A, item: 'committed' },
        { transaction: committed.transaction },
      );
      await committed.commit();
      const seen: string[] = [];
      await target.queue.work(q.transactional, async (job) => {
        seen.push(job.data.item);
      });
      await waitFor(() => seen.length === 1);
      await pause(1_000);
      expect(seen).toEqual(['committed']);
    });

    it('a job that keeps failing ends in the dead-letter queue', async () => {
      let attempts = 0;
      await target.queue.work(q.failing, async () => {
        attempts += 1;
        throw new Error('the source answered 503');
      });
      await target.queue.send(q.failing, { tenant: ORG_A, item: 'broken' });
      const [dead] = await waitFor(async () => {
        const letters = await deadLetters(q.failing);
        return letters.length ? letters : undefined;
      });
      expect(attempts).toBe(2);
      expect(dead).toMatchObject({
        queue: q.failing.name,
        data: { tenant: ORG_A, item: 'broken' },
        error: expect.stringContaining('the source answered 503'),
      });
      const [failing] = await counts([q.failing]);
      expect(failing).toMatchObject({ queue: q.failing.name, deadLetters: 1 });
    });

    it('sending a dead letter back works the job again', async () => {
      let fixed = false;
      const done: string[] = [];
      await target.queue.work(q.redriven, async (job) => {
        if (!fixed) throw new Error('not yet');
        done.push(job.data.item);
      });
      await target.queue.send(q.redriven, { tenant: ORG_A, item: 'later' });
      const letters = await waitFor(async () => {
        const found = await deadLetters(q.redriven);
        return found.length ? found : undefined;
      });
      fixed = true;
      expect(
        await target.queue.redrive(
          q.redriven,
          letters.map((l) => l.id),
        ),
      ).toBe(1);
      await waitFor(() => done.length === 1);
      expect(done).toEqual(['later']);
      expect(await deadLetters(q.redriven)).toEqual([]);
    });

    it('lists dead letters per organisation', async () => {
      await target.queue.work(q.tenants, async () => {
        throw new Error('failed');
      });
      await target.queue.send(q.tenants, { tenant: ORG_A, item: 'a' });
      await target.queue.send(q.tenants, { tenant: ORG_B, item: 'b' });
      await waitFor(async () => (await deadLetters(q.tenants)).length === 2);
      const forB = await deadLetters(q.tenants, { tenant: ORG_B });
      expect(forB.map((letter) => letter.data)).toEqual([{ tenant: ORG_B, item: 'b' }]);
    });

    it('never works a cancelled job', async () => {
      const id = await target.queue.send(q.cancelled, { tenant: ORG_A, item: 'stop' });
      expect(id).toEqual(expect.any(String));
      await target.queue.cancel(q.cancelled, String(id));
      const seen: string[] = [];
      await target.queue.work(q.cancelled, async (job) => {
        seen.push(job.data.item);
      });
      await target.queue.send(q.cancelled, { tenant: ORG_A, item: 'go' });
      await waitFor(() => seen.length === 1);
      await pause(1_000);
      expect(seen).toEqual(['go']);
    });

    it('holds one queued job per key on a short queue', async () => {
      const first = await target.queue.send(q.keyed, { tenant: ORG_A, item: '1' }, { key: 'f' });
      const second = await target.queue.send(q.keyed, { tenant: ORG_A, item: '2' }, { key: 'f' });
      const other = await target.queue.send(q.keyed, { tenant: ORG_A, item: '3' }, { key: 'g' });
      expect(first).toEqual(expect.any(String));
      expect(second).toBeNull();
      expect(other).toEqual(expect.any(String));
    });

    it('takes jobs in priority order', async () => {
      for (const priority of [1, 10, 5])
        await target.queue.send(
          q.prioritised,
          { tenant: ORG_A, item: String(priority) },
          { priority },
        );
      const order: string[] = [];
      await target.queue.work(q.prioritised, async (job) => {
        order.push(job.data.item);
      });
      await waitFor(() => order.length === 3);
      expect(order).toEqual(['10', '5', '1']);
    });
  });
