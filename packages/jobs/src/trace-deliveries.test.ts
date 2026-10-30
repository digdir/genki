import { describe, expect, it } from 'vitest';
import {
  deleteSinkTraces,
  InMemoryTraceDeliveries,
  type TraceSinkClient,
} from './trace-deliveries.js';

const at = '2026-10-29T02:00:00.000Z';
const tenant = '991825827';

const sinkWith = (
  judges: Record<string, string[]>,
  options: { failOn?: string; lingers?: number } = {},
) => {
  const present = new Set([...Object.keys(judges), ...Object.values(judges).flat()]);
  const order: string[] = [];
  let lingering = options.lingers ?? 0;
  const client: TraceSinkClient = {
    judgeTraces: async (trace) => judges[trace] ?? [],
    exists: async (trace) => present.has(trace),
    deleteTrace: async (trace) => {
      if (trace === options.failOn) throw new Error('Langfuse answered HTTP 503');
      order.push(trace);
      present.delete(trace);
    },
    remaining: async (trace) => {
      if (lingering > 0) {
        lingering -= 1;
        return [trace];
      }
      return [trace, ...(judges[trace] ?? [])].filter((t) => present.has(t));
    },
  };
  return { client, order, present };
};

const noWait = { tries: 5, everyMs: 1, wait: async () => undefined };

describe('deleting what genki sent to a trace sink', () => {
  it('keeps checking a judge trace found on an earlier night, after the case and its scores are gone', async () => {
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record([{ tenant, sink: 'etaten', task: 't1', trace: 'case-1' }], at);
    await deliveries.markPending(tenant, { tasks: ['t1'] }, at);
    const present = new Set(['case-1', 'judge-a']);
    let night = 1;
    const client: TraceSinkClient = {
      // The judge is found through the case's scores, which go with the case.
      judgeTraces: async (trace) => (present.has(trace) ? ['judge-a'] : []),
      exists: async (trace) => present.has(trace),
      deleteTrace: async (trace) => {
        // Langfuse deletes in the background: the judge is still there on the first night.
        if (trace !== 'judge-a' || night > 1) present.delete(trace);
      },
      remaining: async (trace) => (present.has(trace) ? [trace] : []),
    };

    const first = await deleteSinkTraces({
      deliveries,
      sinkFor: async () => client,
      verify: noWait,
    });
    const remembered = (await deliveries.pending(10))[0]?.judges;
    night = 2;
    const second = await deleteSinkTraces({
      deliveries,
      sinkFor: async () => client,
      verify: noWait,
    });

    expect(first).toMatchObject({ deleted: 0, failed: 1 });
    expect(remembered).toEqual(['judge-a']);
    expect(second).toMatchObject({ deleted: 1, failed: 0 });
    expect(present.has('judge-a')).toBe(false);
  });

  it("deletes the judges' traces before the case's trace, and only traces marked for deletion", async () => {
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record(
      [
        { tenant, sink: 'etaten', task: 't1', trace: 'case-1' },
        { tenant, sink: 'etaten', task: 't2', trace: 'case-2' },
      ],
      at,
    );
    await deliveries.markPending(tenant, { tasks: ['t1'] }, at);
    const sink = sinkWith({ 'case-1': ['judge-a', 'judge-b'], 'case-2': ['judge-c'] });

    const run = await deleteSinkTraces({
      deliveries,
      sinkFor: async () => sink.client,
      verify: noWait,
    });

    expect(sink.order).toEqual(['judge-a', 'judge-b', 'case-1']);
    expect(run).toMatchObject({ deleted: 1, failed: 0 });
    expect(await deliveries.outstanding(tenant, 'etaten')).toBe(1);
    expect(await deliveries.pending(10)).toEqual([]);
  });

  it('waits for the sink to finish deleting, then counts the delete as confirmed', async () => {
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record([{ tenant, sink: 'etaten', task: 't1', trace: 'case-1' }], at);
    await deliveries.markPending(tenant, { tasks: ['t1'] }, at);
    const sink = sinkWith({ 'case-1': [] }, { lingers: 2 });

    const run = await deleteSinkTraces({
      deliveries,
      sinkFor: async () => sink.client,
      verify: noWait,
    });

    expect(run.deleted).toBe(1);
    expect(await deliveries.outstanding(tenant, 'etaten')).toBe(0);
  });

  it('keeps a delete pending, with what is left, when the sink still has the trace after the check', async () => {
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record([{ tenant, sink: 'etaten', task: 't1', trace: 'case-1' }], at);
    await deliveries.markPending(tenant, { tasks: ['t1'] }, at);
    const sink = sinkWith({ 'case-1': [] }, { lingers: 100 });

    const run = await deleteSinkTraces({
      deliveries,
      sinkFor: async () => sink.client,
      verify: noWait,
    });

    expect(run).toMatchObject({ deleted: 0, failed: 1 });
    expect(await deliveries.pending(10)).toEqual([
      expect.objectContaining({ trace: 'case-1', lastError: 'still in the sink: case-1' }),
    ]);
  });

  it('takes batch after batch within its time budget, and tries each delete once a night', async () => {
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record(
      Array.from({ length: 5 }, (_, i) => ({
        tenant,
        sink: 'etaten',
        task: `t${i}`,
        trace: `case-${i}`,
      })),
      at,
    );
    await deliveries.markPending(tenant, { sink: 'etaten' }, at);
    const sink = sinkWith({}, { failOn: 'case-0' });

    const run = await deleteSinkTraces({
      deliveries,
      sinkFor: async () => sink.client,
      verify: noWait,
      limit: 2,
      budgetMs: 60_000,
    });

    expect(run).toMatchObject({ deleted: 4, failed: 1 });
    expect((await deliveries.pending(10)).map((d) => d.trace)).toEqual(['case-0']);
  });

  it('keeps a failed delete pending for the next night and reports it once it has failed three nights', async () => {
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record([{ tenant, sink: 'etaten', task: 't1', trace: 'case-1' }], at);
    await deliveries.markPending(tenant, { tasks: ['t1'] }, at);
    const sink = sinkWith({ 'case-1': ['judge-a'] }, { failOn: 'judge-a' });
    const night = () =>
      deleteSinkTraces({ deliveries, sinkFor: async () => sink.client, verify: noWait });

    const first = await night();
    const second = await night();
    const third = await night();

    expect(first).toMatchObject({ deleted: 0, failed: 1, failing: [] });
    expect(second.failing).toEqual([]);
    expect(third.failing).toEqual([
      expect.objectContaining({
        trace: 'case-1',
        attempts: 3,
        lastError: 'Langfuse answered HTTP 503',
      }),
    ]);
    expect(await deliveries.pending(10)).toHaveLength(1);
    expect(sink.present.has('case-1')).toBe(true);
  });

  it('keeps the delete pending, with the reason, when the connection is gone', async () => {
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record([{ tenant, sink: 'borte', task: 't1', trace: 'case-1' }], at);
    await deliveries.markPending(tenant, { sink: 'borte' }, at);

    await deleteSinkTraces({ deliveries, sinkFor: async () => undefined, verify: noWait });

    expect(await deliveries.pending(10)).toEqual([
      expect.objectContaining({ lastError: 'the connection borte is gone', attempts: 1 }),
    ]);
  });

  it('marks every trace sent to a sink for deletion, as removing the connection does', async () => {
    const deliveries = new InMemoryTraceDeliveries();
    await deliveries.record(
      [
        { tenant, sink: 'etaten', task: 't1', trace: 'case-1' },
        { tenant, sink: 'etaten', task: 't2', trace: 'case-2' },
        { tenant, sink: 'annen', task: 't3', trace: 'case-3' },
      ],
      at,
    );

    expect(await deliveries.markPending(tenant, { sink: 'etaten' }, at)).toBe(2);
    expect((await deliveries.pending(10)).map((d) => d.trace).sort()).toEqual(['case-1', 'case-2']);
  });
});
