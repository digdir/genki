export type TraceDeliveryState = 'sent' | 'pending' | 'deleted';

/** A trace genki sent to a tenant's trace sink, kept until its delete is confirmed (ADR 0040). */
export interface TraceDelivery {
  tenant: string;
  sink: string;
  task: string;
  trace: string;
  state: TraceDeliveryState;
  attempts: number;
  lastError?: string;
  updatedAt: string;
}

export type TraceSent = Pick<TraceDelivery, 'tenant' | 'sink' | 'task' | 'trace'>;

export interface TraceDeliveryStore {
  record(sent: TraceSent[], at: string): Promise<void>;
  /** Marks the traces of these tasks, or every trace sent to a sink, for deletion. */
  markPending(
    tenant: string,
    by: { tasks: string[] } | { sink: string },
    at: string,
  ): Promise<number>;
  /** Pending deletes of every tenant, oldest first. */
  pending(limit: number): Promise<TraceDelivery[]>;
  settle(
    delivery: TraceDelivery,
    outcome: { deleted: true } | { error: string },
    at: string,
  ): Promise<void>;
  /** Traces sent to a sink that are not deleted yet. */
  outstanding(tenant: string, sink: string): Promise<number>;
}

const keyOf = (d: Pick<TraceDelivery, 'tenant' | 'sink' | 'trace'>) =>
  `${d.tenant}/${d.sink}/${d.trace}`;

export class InMemoryTraceDeliveries implements TraceDeliveryStore {
  readonly #deliveries = new Map<string, TraceDelivery>();

  async record(sent: TraceSent[], at: string) {
    for (const s of sent)
      if (!this.#deliveries.has(keyOf(s)))
        this.#deliveries.set(keyOf(s), { ...s, state: 'sent', attempts: 0, updatedAt: at });
  }

  async markPending(tenant: string, by: { tasks: string[] } | { sink: string }, at: string) {
    let marked = 0;
    for (const d of this.#deliveries.values()) {
      if (d.tenant !== tenant || d.state !== 'sent') continue;
      if ('tasks' in by ? !by.tasks.includes(d.task) : d.sink !== by.sink) continue;
      this.#deliveries.set(keyOf(d), { ...d, state: 'pending', updatedAt: at });
      marked += 1;
    }
    return marked;
  }

  async pending(limit: number) {
    return [...this.#deliveries.values()]
      .filter((d) => d.state === 'pending')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }

  async settle(
    delivery: TraceDelivery,
    outcome: { deleted: true } | { error: string },
    at: string,
  ) {
    const current = this.#deliveries.get(keyOf(delivery));
    if (!current) return;
    const sent = {
      tenant: current.tenant,
      sink: current.sink,
      task: current.task,
      trace: current.trace,
    };
    this.#deliveries.set(
      keyOf(delivery),
      'deleted' in outcome
        ? { ...sent, state: 'deleted', attempts: current.attempts, updatedAt: at }
        : {
            ...sent,
            state: current.state,
            attempts: current.attempts + 1,
            lastError: outcome.error,
            updatedAt: at,
          },
    );
  }

  async outstanding(tenant: string, sink: string) {
    return [...this.#deliveries.values()].filter(
      (d) => d.tenant === tenant && d.sink === sink && d.state !== 'deleted',
    ).length;
  }
}

/** What the delete pass needs of a sink. */
export interface TraceSinkClient {
  /** The traces the sink's own judges made from a trace. */
  judgeTraces(trace: string): Promise<string[]>;
  /** Deletes a trace; a trace that is already gone counts as deleted. */
  deleteTrace(trace: string): Promise<void>;
  /** The trace, and judge traces made from it, that the sink still has. */
  remaining(trace: string): Promise<string[]>;
}

export interface DeleteSinkTracesDeps {
  deliveries: TraceDeliveryStore;
  sinkFor(tenant: string, sink: string): Promise<TraceSinkClient | undefined>;
  now?: () => Date;
  limit?: number;
  /** A delete that has failed this many nights is reported to operators. */
  failingAfter?: number;
  /** The sink deletes in the background: how often and how long to look before giving up. */
  verify?: { tries: number; wait: (ms: number) => Promise<void>; everyMs: number };
}

export interface DeleteSinkTracesRun {
  deleted: number;
  failed: number;
  failing: TraceDelivery[];
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Works through the pending deletes: the judges' traces first, then the case's trace, then a check
 * that nothing of it is left. A failed delete stays pending for the next night.
 */
export const deleteSinkTraces = async (
  deps: DeleteSinkTracesDeps,
): Promise<DeleteSinkTracesRun> => {
  const now = deps.now ?? (() => new Date());
  const failingAfter = deps.failingAfter ?? 3;
  const verify = deps.verify ?? {
    tries: 10,
    everyMs: 3_000,
    wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const run: DeleteSinkTracesRun = { deleted: 0, failed: 0, failing: [] };
  for (const delivery of await deps.deliveries.pending(deps.limit ?? 500)) {
    const fail = async (error: string) => {
      await deps.deliveries.settle(delivery, { error }, now().toISOString());
      run.failed += 1;
      if (delivery.attempts + 1 >= failingAfter)
        run.failing.push({ ...delivery, attempts: delivery.attempts + 1, lastError: error });
    };
    try {
      const sink = await deps.sinkFor(delivery.tenant, delivery.sink);
      if (!sink) {
        await fail(`the connection ${delivery.sink} is gone`);
        continue;
      }
      for (const judge of await sink.judgeTraces(delivery.trace)) await sink.deleteTrace(judge);
      await sink.deleteTrace(delivery.trace);
      let left = await sink.remaining(delivery.trace);
      for (let i = 1; i < verify.tries && left.length > 0; i += 1) {
        await verify.wait(verify.everyMs);
        left = await sink.remaining(delivery.trace);
      }
      if (left.length > 0) {
        await fail(`still in the sink: ${left.join(', ')}`);
        continue;
      }
      await deps.deliveries.settle(delivery, { deleted: true }, now().toISOString());
      run.deleted += 1;
    } catch (error) {
      await fail(messageOf(error));
    }
  }
  return run;
};
