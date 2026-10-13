import type { Principal } from '@genai/contracts';
import type { FilterValue } from '@genai/port-knowledge';
import { KnowledgeError } from '@genai/port-knowledge';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant } from './access.js';
import type { LeaseOptions } from './background-lease.js';
import {
  BatchProblem,
  batchRuns,
  type BatchEstimate,
  type BatchItem,
  type BatchRun,
  type BatchTotals,
} from './batch-runs.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { actorNameOf, changeReasonOf } from './http.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { approvalOf, type Approval } from './project-approvals.js';
import { requestLocale, t, type ApiKey } from './i18n/index.js';
import type { Right } from './rights.js';

type Status = 400 | 401 | 403 | 404 | 409 | 422 | 503;

export const batchRunActions = [
  'platform.batch-run.start',
  'platform.batch-run.cancel',
  'platform.batch-run.retry',
] as const;

const problem = (c: Context, status: Status, title: string, errors: unknown[] = []) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const positive = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number';

const filterValue = (value: unknown): value is FilterValue =>
  scalar(value) ||
  typeof value === 'boolean' ||
  (Array.isArray(value) && value.every(scalar)) ||
  (isRecord(value) &&
    Object.keys(value).every((k) => k === 'gte' || k === 'lte') &&
    Object.values(value).every(scalar));

export const filtersOf = (value: unknown): Record<string, FilterValue> | undefined => {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const out: Record<string, FilterValue> = {};
  for (const [field, v] of Object.entries(value)) {
    if (Array.isArray(v) && v.length === 0) continue;
    if (!filterValue(v)) return undefined;
    out[field] = v;
  }
  return out;
};

export interface Viewer {
  actor: string;
  name?: string;
}

const runView = (run: BatchRun, totals: BatchTotals, viewer?: Viewer) => {
  const shown: Partial<BatchRun> = { ...run };
  delete shown.owner;
  delete shown.heartbeatAt;
  delete shown.queue;
  const ownName =
    !run.startedByName && viewer?.name && viewer.actor === run.startedBy ? viewer.name : undefined;
  return { ...shown, ...(ownName ? { startedByName: ownName } : {}), ...totals };
};

const estimateView = (
  estimate: BatchEstimate,
  approval: { limitNok: number; required: boolean },
) => {
  const shown: Partial<BatchEstimate> = { ...estimate };
  delete shown.documents;
  return { ...shown, preview: estimate.documents.slice(0, 20), approval };
};

const csvCell = (value: unknown) => {
  const raw = value === undefined || value === null ? '' : String(value);
  return /[";\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
};

const itemStatusKeys = {
  queued: 'runs.batchItemQueued',
  running: 'runs.batchItemRunning',
  succeeded: 'runs.batchItemSucceeded',
  notFound: 'runs.batchItemNotFound',
  failed: 'runs.batchItemFailed',
  skipped: 'runs.batchItemSkipped',
} as const satisfies Record<BatchItem['status'], ApiKey>;

const approvalKeys = {
  pending: 'runs.batchApprovalPending',
  approved: 'runs.batchApprovalApproved',
  rejected: 'runs.batchApprovalRejected',
} as const satisfies Record<Approval['status'], ApiKey>;

const csvOf = (run: BatchRun, items: BatchItem[], approval?: Approval) => {
  const header = [
    t('runs.batchCsvNumber'),
    t('runs.batchCsvDocumentId'),
    t('runs.batchCsvTitle'),
    t('runs.batchCsvLink'),
    t('runs.batchCsvDataset'),
    t('runs.batchCsvStatus'),
    t('runs.batchCsvAnswer'),
    t('runs.batchCsvTruncated'),
    t('runs.batchCsvError'),
    t('runs.batchCsvSources'),
    t('runs.batchCsvService'),
    t('runs.batchCsvServiceVersion'),
    t('runs.batchCsvModel'),
    t('runs.batchCsvTokensIn'),
    t('runs.batchCsvTokensOut'),
    t('runs.batchCsvCost'),
    t('runs.batchCsvTask'),
    ...(approval ? [t('runs.batchCsvApproval')] : []),
  ];
  const decimal = requestLocale() === 'en' ? '.' : ',';
  const rows = items.map((i) => [
    i.index + 1,
    i.document.id,
    i.document.title,
    i.document.url,
    run.dataset,
    t(itemStatusKeys[i.status]),
    i.output,
    i.truncated ? t('runs.batchCsvYes') : t('runs.batchCsvNo'),
    i.error,
    i.sources.map((s) => [s.title, s.url].filter(Boolean).join(' ')).join(' | '),
    run.service,
    i.version ?? run.version,
    i.models.join(' ') || run.model,
    i.tokens.input,
    i.tokens.output,
    run.priced ? String(i.costMicroNok / 1_000_000).replace('.', decimal) : '',
    i.task,
    ...(approval ? [t(approvalKeys[approval.status])] : []),
  ]);
  return `\uFEFF${[header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')}\r\n`;
};

const jsonOf = (run: BatchRun, items: BatchItem[], approval?: Approval) => ({
  run: {
    id: run.id,
    service: run.service,
    version: run.version,
    model: run.model,
    dataset: run.dataset,
    filters: run.filters,
    prompt: run.prompt ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status,
    ...(approval ? { approval } : {}),
  },
  items: items.map((i) => ({
    index: i.index,
    document: { ...i.document, dataset: run.dataset },
    status: i.status,
    output: i.output ?? null,
    noAnswer: i.noAnswer ?? false,
    truncated: i.truncated ?? false,
    error: i.error ?? null,
    sources: i.sources,
    service: run.service,
    version: i.version ?? run.version,
    models: i.models.length ? i.models : run.model ? [run.model] : [],
    tokens: i.tokens,
    costMicroNok: run.priced ? i.costMicroNok : null,
    task: i.task ?? null,
    attempts: i.attempts,
    ...(approval ? { approved: approval.status === 'approved' } : {}),
  })),
});

export const createBatchRunsModule =
  (
    options: { onBackground?: (work: Promise<void>) => void; leases?: LeaseOptions } = {},
  ): PlatformModuleFactory =>
  (deps) => {
    const batches = batchRuns(deps, options.leases);
    const background = (work: Promise<void>) => {
      work.catch(() => undefined);
      options.onBackground?.(work);
    };
    background(batches.recover());

    return {
      id: 'batch-runs',
      handlers: routeOnlyActions(batchRunActions),
      mount: <E extends Env, S extends Schema, B extends string>(
        app: Hono<E, S, B>,
        mountDeps: MountDeps,
      ) => {
        const param = (c: Context, name: string) => c.req.param(name) ?? '';
        const body = async (c: Context) => {
          const parsed = (await c.req.json().catch(() => ({}))) as unknown;
          return isRecord(parsed) ? parsed : {};
        };
        const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';
        const inTask = async <T>(
          c: Context,
          principal: Principal,
          tenant: string,
          action: (typeof batchRunActions)[number],
          target: string,
          work: (reason: string) => Promise<T>,
        ) => {
          const reason = reasonOf(c);
          const done = await mountDeps.admin.within(
            principal,
            action,
            { tenant, reason },
            async () => ({
              value: await work(reason),
              target,
            }),
          );
          c.header('genai-task', done.task);
          return done.value;
        };

        const member = async (c: Context, right?: Right) => {
          const principal = await mountDeps.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Du er ikke logget inn') };
          const tenant = param(c, 'tenant');
          const entered = enterTenant(c, mountDeps.access, principal, tenant, right);
          if ('response' in entered) return { response: entered.response };
          return { principal: entered.principal, tenant };
        };
        const viewerOf = (c: Context, principal: Principal): Viewer => {
          const name = actorNameOf(c);
          return { actor: actorOf(principal.actor ?? principal), ...(name ? { name } : {}) };
        };

        const failed = (c: Context, error: unknown) => {
          if (error instanceof AdminRefused) return refusedBy(c, error);
          if (error instanceof BatchProblem)
            return problem(c, error.status, error.message, [
              {
                path: error.path,
                message: error.message,
                ...(error.code ? { code: error.code } : {}),
              },
            ]);
          if (error instanceof KnowledgeError) {
            if (error.code === 'forbidden' || error.code === 'residency')
              return problem(c, 403, 'Du har ikke tilgang til datasettet');
            return problem(c, 422, error.message, [{ path: 'filters', message: error.message }]);
          }
          throw error;
        };

        const base = '/tenants/:tenant/services/:id/batch-runs';

        app.get(`${base}/sources`, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          try {
            return c.json({
              data: await batches.sources(guard.principal, guard.tenant, param(c, 'id')),
            });
          } catch (error) {
            return failed(c, error);
          }
        });

        app.post(`${base}/estimate`, async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          const dataset = text(data.dataset);
          const prompt = text(data.prompt);
          const filters = filtersOf(data.filters);
          const documents =
            Array.isArray(data.documents) && data.documents.every((d) => typeof d === 'string')
              ? (data.documents as string[])
              : undefined;
          const errors = [
            ...(dataset ? [] : [{ path: 'dataset', message: 'a dataset is required' }]),
            ...(filters ? [] : [{ path: 'filters', message: 'filters must be field values' }]),
            ...(data.documents !== undefined && !documents?.length
              ? [{ path: 'documents', message: 'documents is a list of document ids' }]
              : []),
            ...(data.input !== undefined && !isRecord(data.input)
              ? [{ path: 'input', message: 'input is an object of field values' }]
              : []),
          ];
          if (!dataset || !filters || errors.length)
            return problem(c, 400, 'Ugyldig forespørsel', errors);
          try {
            const estimate = await batches.estimate(
              guard.principal,
              guard.tenant,
              param(c, 'id'),
              {
                dataset,
                filters,
                ...(documents ? { documents } : {}),
                ...(prompt ? { prompt } : {}),
                ...(isRecord(data.input) ? { input: data.input } : {}),
                sample: data.sample !== false,
              },
              reasonOf(c) || 'Beregnet kostnad for kjøring over dokumenter',
            );
            const limitNok = batches.approvalLimitOf(guard.tenant);
            return c.json(
              estimateView(estimate, {
                limitNok,
                required: batches.needsApproval(estimate, limitNok),
              }),
              201,
            );
          } catch (error) {
            return failed(c, error);
          }
        });

        app.post(base, async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          const estimate = text(data.estimate);
          if (!estimate)
            return problem(c, 400, 'Beregn kostnaden før du starter', [
              { path: 'estimate', message: 'an estimate id is required' },
            ]);
          const maxCostNok = positive(data.maxCostNok);
          const maxTokens = positive(data.maxTokens);
          const concurrency = positive(data.concurrency);
          const approval = text(data.approval);
          const name = actorNameOf(c);
          try {
            const started = await inTask(
              c,
              guard.principal,
              guard.tenant,
              'platform.batch-run.start',
              `batch-run:${param(c, 'id')}`,
              (reason) =>
                batches.start(
                  guard.principal,
                  guard.tenant,
                  param(c, 'id'),
                  {
                    estimate,
                    ...(maxCostNok === undefined ? {} : { maxCostNok }),
                    ...(maxTokens === undefined ? {} : { maxTokens }),
                    ...(concurrency === undefined ? {} : { concurrency }),
                    ...(approval ? { approval } : {}),
                  },
                  reason,
                  { approval: true, ...(name ? { startedByName: name } : {}) },
                ),
            );
            background(started.done);
            const detail = await batches.detail(guard.tenant, started.run);
            return c.json(runView(started.run, detail.totals, viewerOf(c, guard.principal)), 202);
          } catch (error) {
            return failed(c, error);
          }
        });

        app.get(base, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const runs = await batches.runsOf(guard.tenant, param(c, 'id'));
          const data = await Promise.all(
            runs.map(async (run) =>
              runView(
                run,
                (await batches.detail(guard.tenant, run)).totals,
                viewerOf(c, guard.principal),
              ),
            ),
          );
          return c.json({ data });
        });

        const found = async (c: Context) => {
          const guard = await member(c);
          if (guard.response) return guard;
          const run = await batches.runOf(guard.tenant, param(c, 'id'), param(c, 'runId'));
          if (!run) return { response: problem(c, 404, 'Fant ikke kjøringen') };
          return { ...guard, run, detail: await batches.detail(guard.tenant, run) };
        };

        app.get(`${base}/:runId`, async (c) => {
          const guard = await found(c);
          if (guard.response) return guard.response;
          return c.json({
            ...runView(guard.run, guard.detail.totals, viewerOf(c, guard.principal)),
            items: guard.detail.items,
          });
        });

        app.get(`${base}/:runId/export`, async (c) => {
          const guard = await found(c);
          if (guard.response) return guard.response;
          const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
          const name = `kjoring-${guard.run.service}-${guard.run.id.slice(0, 8)}.${format}`;
          const disposition = { 'content-disposition': `attachment; filename="${name}"` };
          const approval = await approvalOf(mountDeps.configEntries, guard.tenant, guard.run.id);
          if (format === 'csv')
            return c.body(csvOf(guard.run, guard.detail.items, approval), 200, {
              'content-type': 'text/csv; charset=utf-8',
              ...disposition,
            });
          return c.json(jsonOf(guard.run, guard.detail.items, approval), 200, disposition);
        });

        app.post(`${base}/:runId/cancel`, async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          try {
            await inTask(
              c,
              guard.principal,
              guard.tenant,
              'platform.batch-run.cancel',
              `batch-run:${param(c, 'id')}/${param(c, 'runId')}`,
              (reason) =>
                batches.cancel(
                  guard.principal,
                  guard.tenant,
                  param(c, 'id'),
                  param(c, 'runId'),
                  reason,
                ),
            );
            return c.json({ id: param(c, 'runId'), cancelling: true }, 202);
          } catch (error) {
            return failed(c, error);
          }
        });

        app.post(`${base}/:runId/retry`, async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          const maxCostNok = positive(data.maxCostNok);
          const maxTokens = positive(data.maxTokens);
          const items =
            Array.isArray(data.items) && data.items.every((i) => Number.isInteger(i))
              ? (data.items as number[])
              : undefined;
          try {
            const retried = await inTask(
              c,
              guard.principal,
              guard.tenant,
              'platform.batch-run.retry',
              `batch-run:${param(c, 'id')}/${param(c, 'runId')}`,
              (reason) =>
                batches.retry(
                  guard.principal,
                  guard.tenant,
                  param(c, 'id'),
                  param(c, 'runId'),
                  {
                    ...(maxCostNok === undefined ? {} : { maxCostNok }),
                    ...(maxTokens === undefined ? {} : { maxTokens }),
                    ...(items ? { items } : {}),
                  },
                  reason,
                ),
            );
            background(retried.done);
            const detail = await batches.detail(guard.tenant, retried.run);
            return c.json(
              {
                ...runView(retried.run, detail.totals, viewerOf(c, guard.principal)),
                retried: retried.retried,
              },
              202,
            );
          } catch (error) {
            return failed(c, error);
          }
        });
      },
    };
  };

export const batchRunsModule = createBatchRunsModule();
