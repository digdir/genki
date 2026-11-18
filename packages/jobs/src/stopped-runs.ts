import type { Event, Usage } from '@genai/contracts';
import { addUsage, type ContentScope, type StoredTask } from '@genai/kernel';

export const stoppedRunCode = 'server_stopped';
export const stoppedRunMessage = 'the server stopped during the run';

export interface StoppedRunDeps {
  tasks: {
    claimStopped(limit: number): Promise<{ id: string; tenant: string; scope: string }[]>;
    get(id: string): Promise<StoredTask | undefined>;
    put(stored: StoredTask, scope: ContentScope): Promise<void>;
  };
  events: {
    append(event: Omit<Event, 'seq'>, scope: ContentScope): Promise<Event>;
    ofType(tasks: string[], type: string): Promise<Event[]>;
  };
  now?: () => Date;
  limit?: number;
}

const usageOf = (events: Event[]): Usage =>
  events.reduce<Usage>(
    (sum, e) => addUsage(sum, ((e.data ?? {}) as { usage?: Usage }).usage ?? {}),
    {},
  );

export const failStoppedRuns = async (deps: StoppedRunDeps): Promise<string[]> => {
  const now = deps.now ?? (() => new Date());
  const failed: string[] = [];
  for (const claimed of await deps.tasks.claimStopped(deps.limit ?? 100)) {
    const stored = await deps.tasks.get(claimed.id);
    if (!stored || !['queued', 'running'].includes(stored.task.status)) continue;
    const scope = { tenant: claimed.tenant, key: claimed.scope };
    const statuses = await deps.events.ofType([claimed.id], 'kernel.task.status');
    const errors = (await deps.events.ofType([claimed.id], 'kernel.error')).filter(
      (e) => (e.data as { code?: unknown } | undefined)?.code === stoppedRunCode,
    );
    const last = statuses.at(-1);
    let lastSeq = Math.max(stored.lastSeq, last?.seq ?? -1, ...errors.map((e) => e.seq));
    const append = async (type: string, data: unknown, audit = false) => {
      const appended = await deps.events.append(
        {
          type,
          v: 1,
          task: claimed.id,
          ts: now().toISOString(),
          data,
          actor: 'kernel',
          ...(audit ? { audience: 'audit' as const } : {}),
        },
        scope,
      );
      lastSeq = appended.seq;
    };
    const error = { code: stoppedRunCode, message: stoppedRunMessage };
    if (!errors.some((e) => e.audience === 'audit')) await append('kernel.error', error, true);
    if (!errors.some((e) => e.audience !== 'audit')) await append('kernel.error', error);
    if ((last?.data as { status?: unknown } | undefined)?.status !== 'failed')
      await append('kernel.task.status', { status: 'failed' });
    const usage = usageOf(await deps.events.ofType([claimed.id], 'kernel.usage'));
    await deps.tasks.put(
      {
        ...stored,
        task: { ...stored.task, status: 'failed', endedAt: now().toISOString(), usage },
        lastSeq,
      },
      scope,
    );
    failed.push(claimed.id);
  }
  return failed;
};
