import type { Event, Task } from '@genai/contracts';
import { KernelError, type Kernel } from '@genai/kernel';
import type { Principal } from '@genai/contracts';
import { mapRun, type RunStats, type TimelineStep } from './run-steps.js';

export { warningText, type TimelineBlock, type TimelineStep } from './run-steps.js';

export interface TaskReader {
  task(id: string): Promise<Task | undefined>;
  events(id: string): Promise<Event[]>;
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
  steps: TimelineStep[];
  stats: RunStats | Omit<RunStats, UsageStats>;
}

type UsageStats =
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedInputTokens'
  | 'costMicroNok'
  | 'unpricedTokens'
  | 'byModel';

const seconds = (from: string, to: string) =>
  Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 10) / 100);

const auditKept = new Set(['kernel.error', 'kernel.usage', 'kernel.task.input']);

export const kernelTaskReader = (kernel: Kernel, reader: Principal): TaskReader => ({
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
  options: { details?: boolean; usage?: boolean } = {},
): TaskTimeline => {
  const usage = options.usage ?? true;
  const mapper = mapRun(events, {
    details: options.details ?? false,
    usage,
    startedAt: task.createdAt,
  });
  const {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    costMicroNok,
    unpricedTokens,
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
          priced: !unpricedRun && unpricedTokens === 0,
        }
      : {}),
    steps: mapper.steps,
    stats: usage
      ? {
          ...counts,
          inputTokens,
          outputTokens,
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          costMicroNok,
          unpricedTokens,
          byModel,
        }
      : counts,
  };
};
