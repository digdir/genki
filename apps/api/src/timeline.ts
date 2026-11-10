import type { Event, Task } from '@genai/contracts';
import { KernelError, type Kernel, type TaskErasure, type TaskStore } from '@genai/kernel';
import type { Principal } from '@genai/contracts';
import { mapRun, type RunStats, type TimelineStep } from './run-steps.js';

export { warningText, type TimelineBlock, type TimelineStep } from './run-steps.js';

export type Erasure = Omit<TaskErasure, 'task'>;

export interface TaskReader {
  task(id: string): Promise<Task | undefined>;
  events(id: string): Promise<Event[]>;
  erasure?(tenant: string, id: string): Promise<Erasure | undefined>;
}

export interface TaskTimeline {
  id: string;
  service: string;
  serviceName?: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  trigger: string;
  caller: string;
  startedAt: string;
  durationSeconds: number;
  inputTokens?: number;
  outputTokens?: number;
  costOre?: number;
  costMicroNok?: number | null;
  priced?: boolean;
  units?: Record<string, number>;
  unpricedUnits?: Record<string, number>;
  erasure?: Erasure;
  steps: TimelineStep[];
  stats: RunStats | Omit<RunStats, UsageStats>;
}

type UsageStats =
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'costMicroNok'
  | 'unpricedTokens'
  | 'units'
  | 'unpricedUnits'
  | 'byModel';

const seconds = (from: string, to: string) =>
  Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 10) / 100);

const auditKept = new Set(['kernel.error', 'kernel.usage', 'kernel.task.input']);

export const erasureOf = ({ reason, at }: TaskErasure): Erasure => ({
  reason,
  ...(at ? { at } : {}),
});

export const kernelTaskReader = (
  kernel: Kernel,
  reader: Principal,
  store?: Pick<TaskStore, 'erasures'>,
): TaskReader => ({
  ...(store?.erasures
    ? {
        erasure: async (tenant: string, id: string) => {
          const [found] = (await store.erasures?.(tenant, [id])) ?? [];
          return found && erasureOf(found);
        },
      }
    : {}),
  task: async (id) => {
    try {
      return await kernel.task(reader, id);
    } catch (error) {
      if (error instanceof KernelError && error.code === 'not_found') return undefined;
      throw error;
    }
  },
  events: async (id) => {
    const events: Event[] = [];
    try {
      for await (const e of await kernel.events(reader, id)) events.push(e);
    } catch (error) {
      if (error instanceof KernelError && error.code === 'not_found') return [];
      throw error;
    }
    return events.filter((e) => e.audience !== 'audit' || auditKept.has(e.type));
  },
});

export const toTimeline = (
  task: Task,
  events: Event[],
  now: Date,
  serviceName?: string,
  options: { details?: boolean; usage?: boolean; erasure?: Erasure } = {},
): TaskTimeline => {
  const usage = options.usage ?? true;
  const mapper = mapRun(events, {
    details: options.details ?? false,
    usage,
    startedAt: task.createdAt,
    erased: options.erasure !== undefined,
  });
  const {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costMicroNok,
    unpricedTokens,
    units,
    unpricedUnits,
    byModel,
    ...counts
  } = mapper.stats();
  const tokens = (task.usage.inputTokens ?? 0) + (task.usage.outputTokens ?? 0);
  const unpricedRun = tokens > 0 && task.usage.costMicroNok === undefined;
  return {
    id: task.id,
    service: task.service.capability.id,
    ...(serviceName ? { serviceName } : {}),
    status: task.status === 'queued' ? 'running' : task.status,
    trigger: task.parent ? 'subtask' : task.thread ? 'conversation' : 'api',
    caller: task.principal.kind,
    startedAt: task.createdAt,
    durationSeconds: seconds(task.createdAt, task.endedAt ?? now.toISOString()),
    ...(usage
      ? {
          inputTokens: task.usage.inputTokens ?? 0,
          outputTokens: task.usage.outputTokens ?? 0,
          costOre: Math.round((task.usage.costMicroNok ?? 0) / 10_000),
          costMicroNok: unpricedRun ? null : (task.usage.costMicroNok ?? 0),
          priced:
            !unpricedRun && unpricedTokens === 0 && Object.keys(unpricedUnits ?? {}).length === 0,
          ...(units ? { units } : {}),
          ...(unpricedUnits ? { unpricedUnits } : {}),
        }
      : {}),
    ...(options.erasure ? { erasure: options.erasure } : {}),
    steps: mapper.steps,
    stats: usage
      ? {
          ...counts,
          inputTokens,
          outputTokens,
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          costMicroNok,
          unpricedTokens,
          ...(units ? { units } : {}),
          ...(unpricedUnits ? { unpricedUnits } : {}),
          byModel,
        }
      : counts,
  };
};
