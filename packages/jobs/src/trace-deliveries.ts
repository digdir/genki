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
  /** Judge traces found on an earlier attempt, checked again although the case's scores are gone. */
  judges?: string[];
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
  /** Remembers the judge traces found for a delivery, before its case's trace is deleted. */
  noteJudges(delivery: TraceDelivery, judges: string[], at: string): Promise<void>;
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
    // A confirmed delete leaves nothing behind: the id is kept only until then (ADR 0040).
    if ('deleted' in outcome) {
      this.#deliveries.delete(keyOf(delivery));
      return;
    }
    const sent = {
      tenant: current.tenant,
      sink: current.sink,
      task: current.task,
      trace: current.trace,
      ...(current.judges ? { judges: current.judges } : {}),
    };
    this.#deliveries.set(keyOf(delivery), {
      ...sent,
      state: current.state,
      attempts: current.attempts + 1,
      lastError: outcome.error,
      updatedAt: at,
    });
  }

  async outstanding(tenant: string, sink: string) {
    return [...this.#deliveries.values()].filter(
      (d) => d.tenant === tenant && d.sink === sink && d.state !== 'deleted',
    ).length;
  }

  async noteJudges(delivery: TraceDelivery, judges: string[], at: string) {
    const current = this.#deliveries.get(keyOf(delivery));
    if (current) this.#deliveries.set(keyOf(delivery), { ...current, judges, updatedAt: at });
  }
}

/** What the delete pass needs of a sink. */
export interface TraceSinkClient {
  /** The traces the sink's own judges made from a trace. */
  judgeTraces(trace: string): Promise<string[]>;
  /** Whether the sink still has a trace. */
  exists(trace: string): Promise<boolean>;
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
  /** Keep taking pending deletes, a batch at a time, until none is left or this much time has gone. */
  budgetMs?: number;
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
  const until = deps.budgetMs === undefined ? undefined : now().getTime() + deps.budgetMs;
  const tried = new Set<string>();
  const next = async () =>
    (await deps.deliveries.pending(deps.limit ?? 500)).filter(
      (d) => !tried.has(`${d.tenant}/${d.sink}/${d.trace}`),
    );
  for (let batch = await next(); batch.length > 0; batch = until === undefined ? [] : await next())
    for (const delivery of batch) {
      if (until !== undefined && now().getTime() >= until) return run;
      tried.add(`${delivery.tenant}/${delivery.sink}/${delivery.trace}`);
      await deleteOne(delivery);
    }
  return run;

  async function deleteOne(delivery: TraceDelivery) {
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
        return;
      }
      // Judges found through the case's scores cannot be found again once the case is deleted.
      const judges = [
        ...new Set([...(delivery.judges ?? []), ...(await sink.judgeTraces(delivery.trace))]),
      ];
      if (judges.length > (delivery.judges?.length ?? 0))
        await deps.deliveries.noteJudges(delivery, judges, now().toISOString());
      for (const judge of judges) await sink.deleteTrace(judge);
      await sink.deleteTrace(delivery.trace);
      const remaining = async () => [
        ...new Set([
          ...(await sink.remaining(delivery.trace)),
          ...(
            await Promise.all(judges.map(async (j) => ((await sink.exists(j)) ? [j] : [])))
          ).flat(),
        ]),
      ];
      let left = await remaining();
      for (let i = 1; i < verify.tries && left.length > 0; i += 1) {
        await verify.wait(verify.everyMs);
        left = await remaining();
      }
      if (left.length > 0) {
        await fail(`still in the sink: ${left.join(', ')}`);
        return;
      }
      await deps.deliveries.settle(delivery, { deleted: true }, now().toISOString());
      run.deleted += 1;
    } catch (error) {
      await fail(messageOf(error));
    }
  }
};
