import type { TrackedTask } from './extensions.js';
import type { Execution } from './ingestion.js';
import { createFormat } from '@genai/i18n';
import { requestLocale, t } from './i18n/index.js';

export type ComponentStatus = 'normal' | 'degraded' | 'down';

export interface OperationsComponent {
  name: string;
  status: ComponentStatus;
  errorRate?: string;
  p95?: string;
  note?: string;
}

export interface OperationsQueueItem {
  type: string;
  what: string;
  status: 'running' | 'waiting' | 'failed';
  age: string;
  at: string;
}

export interface FailingTrigger {
  tenant: string;
  what: string;
  error: string;
  failedAt: string;
  lastSuccess?: string;
}

export interface OperationsOverview {
  incidents: { title: string; text: string }[];
  components: OperationsComponent[];
  queueStats: { label: string; value: string }[];
  queue: OperationsQueueItem[];
  triggers: FailingTrigger[];
}

export interface PipelineRuns {
  tenant: string;
  dataset: string;
  pipeline: string;
  scheduled: boolean;
  executions: Execution[];
}

export interface OperationsDeps {
  now(): Date;
  models(): { id: string; endpoint: string; enabled: boolean }[];
  ingestion(): { available: boolean; reason?: string };
  pipelines(): Promise<PipelineRuns[]>;
  tasks(): Promise<TrackedTask[]>;
  tenantNames(): Promise<Map<string, string>>;
  database?(): Promise<unknown>;
}

const hour = 60 * 60 * 1000;
const day = 24 * hour;
const degradedShare = 0.05;
const downShare = 0.5;

const percent = (share: number) =>
  `${createFormat(requestLocale()).number(share * 100, { maximumFractionDigits: 1 })} %`;

export const elapsed = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return t('operations.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  return minutes % 60
    ? t('operations.hoursMinutes', { hours, minutes: minutes % 60 })
    : t('operations.hours', { hours });
};

const failureStatus = (failed: number, finished: number): ComponentStatus =>
  finished === 0
    ? 'normal'
    : failed / finished >= downShare
      ? 'down'
      : failed / finished >= degradedShare
        ? 'degraded'
        : 'normal';

const measured = (name: string, failed: number, finished: number): OperationsComponent => ({
  name,
  status: failureStatus(failed, finished),
  ...(finished === 0 ? {} : { errorRate: percent(failed / finished) }),
});

export const operationsOverview = async (deps: OperationsDeps): Promise<OperationsOverview> => {
  const now = deps.now().getTime();
  const since = (iso: string | undefined, window: number) =>
    iso !== undefined && now - new Date(iso).getTime() <= window;
  const [pipelines, tasks, names] = await Promise.all([
    deps.pipelines(),
    deps.tasks(),
    deps.tenantNames(),
  ]);
  const nameOf = (tenant: string) => names.get(tenant) ?? tenant;
  const components: OperationsComponent[] = [{ name: 'API', status: 'normal' }];

  if (deps.database) {
    const started = Date.now();
    const ok = await deps.database().then(
      () => true,
      () => false,
    );
    components.push(
      ok
        ? {
            name: t('operations.database'),
            status: 'normal',
            note: t('operations.databaseAnswered', { ms: Date.now() - started }),
          }
        : { name: t('operations.database'), status: 'down', note: t('operations.databaseDown') },
    );
  }

  const byEndpoint = new Map<string, { total: number; enabled: number }>();
  for (const m of deps.models()) {
    const entry = byEndpoint.get(m.endpoint) ?? { total: 0, enabled: 0 };
    entry.total += 1;
    if (m.enabled) entry.enabled += 1;
    byEndpoint.set(m.endpoint, entry);
  }
  for (const [endpoint, count] of [...byEndpoint.entries()].sort(([a], [b]) => a.localeCompare(b)))
    components.push({
      name: t('operations.models', { endpoint }),
      status: count.enabled > 0 ? 'normal' : 'down',
      note: t('operations.modelsInUse', { enabled: count.enabled, total: count.total }),
    });

  const finishedTasks = tasks.filter(
    (t) => (t.status === 'completed' || t.status === 'failed') && since(t.at, hour),
  );
  const failedTasks = finishedTasks.filter((t) => t.status === 'failed').length;
  components.push(measured(t('operations.runs'), failedTasks, finishedTasks.length));

  const executions = pipelines.flatMap((p) => p.executions.map((e) => ({ ...e, owner: p })));
  const finishedRuns = executions.filter((e) => e.status !== 'running' && since(e.endedAt, hour));
  const failedRuns = finishedRuns.filter((e) => e.status === 'failed').length;
  const backend = deps.ingestion();
  components.push(
    backend.available
      ? measured(t('operations.ingestion'), failedRuns, finishedRuns.length)
      : {
          name: t('operations.ingestion'),
          status: 'down',
          note: backend.reason ?? t('operations.ingestionUnavailable'),
        },
  );

  const running = executions.filter((e) => e.status === 'running');
  const failedLastDay = executions.filter(
    (e) => e.status === 'failed' && since(e.endedAt ?? e.startedAt, day),
  );
  const what = (e: (typeof executions)[number]) =>
    `${e.owner.pipeline} · ${e.owner.dataset} · ${nameOf(e.owner.tenant)}`;
  const queue: OperationsQueueItem[] = [
    ...running
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((e) => ({
        type: t('operations.ingestion'),
        what: what(e),
        status: 'running' as const,
        age: elapsed(now - new Date(e.startedAt).getTime()),
        at: e.startedAt,
      })),
    ...failedLastDay
      .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
      .map((e) => ({
        type: t('operations.ingestion'),
        what: what(e),
        status: 'failed' as const,
        age: elapsed(now - new Date(e.endedAt ?? e.startedAt).getTime()),
        at: e.endedAt ?? e.startedAt,
      })),
  ];
  const longest = running.reduce<number | undefined>((max, e) => {
    const age = now - new Date(e.startedAt).getTime();
    return max === undefined || age > max ? age : max;
  }, undefined);
  const activeTasks = tasks.filter((t) => t.status === 'running' || t.status === 'queued');

  const triggers: FailingTrigger[] = [];
  for (const p of pipelines) {
    if (!p.scheduled) continue;
    const [latest] = [...p.executions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    if (latest?.status !== 'failed') continue;
    const lastSuccess = p.executions
      .filter((e) => e.status === 'succeeded')
      .map((e) => e.endedAt ?? e.startedAt)
      .sort()
      .at(-1);
    triggers.push({
      tenant: nameOf(p.tenant),
      what: t('operations.scheduledIngestion', { pipeline: p.pipeline, dataset: p.dataset }),
      error: latest.error ?? t('operations.ingestionFailed'),
      failedAt: latest.endedAt ?? latest.startedAt,
      ...(lastSuccess ? { lastSuccess } : {}),
    });
  }

  return {
    incidents: [],
    components,
    queueStats: [
      { label: t('operations.runningIngestions'), value: String(running.length) },
      { label: t('operations.failedIngestions'), value: String(failedLastDay.length) },
      { label: t('operations.activeRuns'), value: String(activeTasks.length) },
      ...(longest === undefined
        ? []
        : [{ label: t('operations.longestIngestion'), value: elapsed(longest) }]),
    ],
    queue,
    triggers,
  };
};
