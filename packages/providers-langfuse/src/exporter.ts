import { createHmac } from 'node:crypto';
import type { Event, Task } from '@genai/contracts';
import type { ContentScope, EventLog, SecretResolver } from '@genai/kernel';
import { exporterConfig, tracesUrl, type ExporterConfigInput } from './config.js';
import { evaluationIn, type Experiment } from './experiment.js';
import { buildSpans, rootSpanIdFor, sampled, traceIdFor, type OtlpSpan } from './spans.js';

export interface ExporterStats {
  exported: number;
  dropped: number;
  failed: number;
  sampledOut: number;
}

export interface TraceExporter {
  observe(event: Event, scope: ContentScope): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  stats(): ExporterStats;
}

export interface ExporterDeps {
  secrets: SecretResolver;
  tasks: (id: string) => Promise<Task | undefined>;
  fetch?: typeof fetch;
  serviceName?: string;
}

interface Open {
  firstTs: string;
  events: Event[];
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const retryable = (status: number) => status === 429 || status === 408 || status >= 500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const createTraceExporter = (
  input: ExporterConfigInput,
  deps: ExporterDeps,
): TraceExporter => {
  const config = exporterConfig.parse(input);
  const send = deps.fetch ?? fetch;
  const url = tracesUrl(config.endpoint);
  const open = new Map<string, Open>();
  const experiments = new Map<string, Experiment>();
  const queue: OtlpSpan[] = [];
  const building = new Set<Promise<void>>();
  const stats: ExporterStats = { exported: 0, dropped: 0, failed: 0, sampledOut: 0 };
  let sending: Promise<void> | undefined;
  let stopped = false;
  let headers: Promise<Record<string, string>> | undefined;
  let pseudonymKey: Promise<string | undefined> | undefined;

  const authHeaders = async (): Promise<Record<string, string>> => {
    const { auth } = config;
    if (auth.kind === 'none') return {};
    if (auth.kind === 'header') return { [auth.name]: await deps.secrets.resolve(auth.secret) };
    const secret = await deps.secrets.resolve(auth.secretKey);
    return {
      authorization: `Basic ${Buffer.from(`${auth.publicKey}:${secret}`).toString('base64')}`,
      'x-langfuse-ingestion-version': '4',
    };
  };

  const pseudonym = async (task: Task | undefined) => {
    if (!task || !config.pseudonymKey) return undefined;
    pseudonymKey ??= deps.secrets.resolve(config.pseudonymKey);
    const key = await pseudonymKey;
    if (!key) return undefined;
    return createHmac('sha256', key)
      .update(`${task.principal.kind}:${task.principal.id}`)
      .digest('hex')
      .slice(0, 32);
  };

  const rootOf = async (task: Task | undefined) => {
    let current = task;
    for (let depth = 0; current?.parent && depth < 16; depth++) {
      const parent = await deps.tasks(current.parent);
      if (!parent) return current.parent;
      current = parent;
    }
    return current?.id;
  };

  const enqueue = (spans: OtlpSpan[]) => {
    if (spans.length === 0) return;
    if (queue.length + spans.length > config.batch.maxQueue) {
      stats.dropped += spans.length;
      return;
    }
    queue.push(...spans);
    if (queue.length >= config.batch.maxSpans) void flushQueue();
  };

  const track = (event: Event) => {
    const evaluation = evaluationIn(event);
    if (evaluation && experiments.size < config.limits.openTasks)
      experiments.set(event.task, { ...evaluation, rootTask: event.task });
    if (event.type !== 'kernel.task.spawned') return;
    const parent = experiments.get(event.task);
    const child = (event.data as { child?: unknown } | undefined)?.child;
    if (parent && typeof child === 'string') experiments.set(child, parent);
  };

  const build = async (taskId: string, state: Open, terminal: Event | undefined) => {
    const experiment = experiments.get(taskId);
    if (terminal) experiments.delete(taskId);
    const task = await deps.tasks(taskId);
    const rootTask = experiment?.rootTask ?? (await rootOf(task)) ?? taskId;
    if (!experiment && !sampled(rootTask, config.sampleRate)) {
      stats.sampledOut += 1;
      return;
    }
    const userId = await pseudonym(task);
    enqueue(
      buildSpans({
        task,
        taskId,
        traceId: traceIdFor(rootTask),
        ...(task?.parent && taskId !== rootTask
          ? { parentSpanId: rootSpanIdFor(task.parent) }
          : {}),
        events: state.events,
        firstTs: state.firstTs,
        terminal,
        content: config.content,
        ...(config.environment ? { environment: config.environment } : {}),
        ...(userId ? { userId } : {}),
        ...(experiment ? { experiment } : {}),
      }),
    );
  };

  const startBuild = (taskId: string, state: Open, terminal: Event | undefined) => {
    const promise = build(taskId, state, terminal)
      .catch(() => {
        stats.failed += 1;
      })
      .finally(() => building.delete(promise));
    building.add(promise);
  };

  const post = async (batch: OtlpSpan[]) => {
    headers ??= authHeaders();
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: deps.serviceName ?? 'genki' } },
            ],
          },
          scopeSpans: [{ scope: { name: '@genai/providers-langfuse' }, spans: batch }],
        },
      ],
    });
    for (let attempt = 0; ; attempt++) {
      let status: number;
      try {
        const response = await send(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(await headers) },
          body,
        });
        status = response.status;
        await response.body?.cancel();
      } catch {
        status = 0;
      }
      if (status >= 200 && status < 300) {
        stats.exported += batch.length;
        return;
      }
      if ((status !== 0 && !retryable(status)) || attempt >= config.batch.maxRetries) {
        stats.failed += batch.length;
        return;
      }
      await sleep(Math.min(config.batch.backoffMs * 2 ** attempt, 30_000));
    }
  };

  const flushQueue = (): Promise<void> => {
    sending ??= (async () => {
      while (queue.length > 0) await post(queue.splice(0, config.batch.maxSpans));
    })().finally(() => {
      sending = undefined;
    });
    return sending;
  };

  const timer = setInterval(() => void flushQueue(), config.batch.intervalMs);
  timer.unref();

  const observe = (event: Event, _scope: ContentScope) => {
    if (stopped) return;
    try {
      let state = open.get(event.task);
      if (!state) {
        if (open.size >= config.limits.openTasks) {
          stats.dropped += 1;
          return;
        }
        state = { firstTs: event.ts, events: [] };
        open.set(event.task, state);
      }
      if (state.events.length < config.limits.eventsPerTask) state.events.push(event);
      else stats.dropped += 1;
      track(event);

      if (event.type !== 'kernel.task.status') return;
      const status = (event.data as { status?: string } | undefined)?.status ?? '';
      if (terminalStatuses.has(status)) {
        open.delete(event.task);
        startBuild(event.task, state, event);
      } else if (status === 'interrupted') {
        const snapshot = { firstTs: state.firstTs, events: state.events };
        state.events = [];
        startBuild(event.task, snapshot, undefined);
      }
    } catch {
      stats.dropped += 1;
    }
  };

  const flush = async () => {
    await Promise.all([...building]);
    await flushQueue();
  };

  return {
    observe,
    flush,
    shutdown: async () => {
      stopped = true;
      clearInterval(timer);
      await flush();
    },
    stats: () => ({ ...stats }),
  };
};

export const observedEventLog = (
  inner: EventLog,
  exporter: Pick<TraceExporter, 'observe'>,
): EventLog => ({
  append: async (event, scope) => {
    const stored = await inner.append(event, scope);
    try {
      exporter.observe(stored, scope);
    } catch {
      return stored;
    }
    return stored;
  },
  read: (task, fromSeq, isLive) => inner.read(task, fromSeq, isLive),
  wake: (task) => inner.wake(task),
});
