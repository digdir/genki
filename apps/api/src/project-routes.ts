import { randomUUID } from 'node:crypto';
import { KnowledgeError } from '@genai/port-knowledge';
import type { Principal } from '@genai/contracts';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnly } from './admin.js';
import { costVisible, filtersOf, withoutCost } from './batch-run-routes.js';
import type { BatchEstimate, BatchRun, BatchTotals } from './batch-runs.js';
import { BatchProblem } from './batch-runs.js';
import { appendVersion, type ConfigEntry } from './config-store.js';
import { actorNameOf, changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import {
  approvalsOf,
  recordReview,
  reviewHistory,
  type ReviewDecision,
} from './project-approvals.js';
import {
  ProjectInvalid,
  projectKind,
  projectRunKind,
  projects as createProjects,
  subscriptionKind,
  type Project,
  type ProjectRun,
  type ProjectSelection,
  type ProjectsOptions,
  type SubscriptionMode,
} from './projects.js';
import { seesUsage, type Right } from './rights.js';

type Status = 400 | 401 | 403 | 404 | 409 | 422 | 503;

export const projectPointKind = 'project-point';

export const projectActions = [
  'platform.project.create',
  'platform.project.update',
  'platform.project.delete',
  'platform.project.point.add',
  'platform.project.run.estimate',
  'platform.project.run.start',
  'platform.project.run.cancel',
  'platform.project.run.retry',
  'platform.project.run.review',
  'platform.project.subscription.save',
  'platform.project.subscription.delete',
  'platform.project.subscription.pause',
  'platform.project.subscription.resume',
  'platform.project.subscription.check',
] as const;

interface ProjectPoint {
  project: string;
  text: string;
  changedBy?: string;
}

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

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;

const runView = (run: BatchRun, totals: BatchTotals) => {
  const shown: Partial<BatchRun> = { ...run };
  delete shown.owner;
  delete shown.heartbeatAt;
  delete shown.queue;
  return { ...shown, ...totals };
};

const estimateView = (estimate: BatchEstimate) => {
  const shown: Partial<BatchEstimate> = { ...estimate };
  delete shown.documents;
  return { ...shown, preview: estimate.documents.slice(0, 20) };
};

const projectView = (entry: ConfigEntry<Project>) => ({
  ...entry.spec,
  version: entry.version,
  by: entry.by,
  at: entry.at,
  reason: entry.reason,
});

const projectInput = (data: Record<string, unknown>) => {
  const errors: { path: string; message: string }[] = [];
  const name = typeof data.name === 'string' ? data.name : '';
  const purpose = typeof data.purpose === 'string' ? data.purpose : '';
  if (purpose.length > 4000) errors.push({ path: 'purpose', message: 'at most 4000 characters' });
  if (name.length > 120) errors.push({ path: 'name', message: 'at most 120 characters' });
  const rawSelections = data.selections ?? [];
  const selections: ProjectSelection[] = [];
  if (!Array.isArray(rawSelections))
    errors.push({ path: 'selections', message: 'selections is a list' });
  else
    rawSelections.forEach((raw, i) => {
      if (!isRecord(raw)) {
        errors.push({ path: `selections[${i}]`, message: 'a selection is an object' });
        return;
      }
      const dataset = text(raw.dataset);
      const filters = filtersOf(raw.filters);
      const documents = raw.documents === undefined ? undefined : strings(raw.documents);
      if (!dataset)
        errors.push({ path: `selections[${i}].dataset`, message: 'a dataset is required' });
      if (!filters)
        errors.push({ path: `selections[${i}].filters`, message: 'filters must be field values' });
      if (raw.documents !== undefined && !documents)
        errors.push({ path: `selections[${i}].documents`, message: 'a list of document ids' });
      if (documents && documents.length > 1000)
        errors.push({ path: `selections[${i}].documents`, message: 'at most 1000 documents' });
      selections.push({
        id: text(raw.id) ?? '',
        name: text(raw.name) ?? '',
        dataset: dataset ?? '',
        filters: filters ?? {},
        ...(documents ? { documents } : {}),
      });
    });
  const services = data.services === undefined ? [] : strings(data.services);
  if (!services) errors.push({ path: 'services', message: 'services is a list of service ids' });
  return {
    errors,
    input: { name, purpose, selections, services: services ?? [] },
  };
};

export const createProjectsModule =
  (options: ProjectsOptions & { watch?: boolean } = {}): PlatformModuleFactory =>
  (deps) => {
    const background = (work: Promise<void>) => {
      work.catch(() => undefined);
      options.onBackground?.(work);
    };
    const projects = createProjects(deps, { ...options, onBackground: background });
    if (options.watch !== false) projects.watch();

    return {
      id: 'projects',
      handlers: Object.fromEntries(projectActions.map((action) => [action, routeOnly])),
      mount: <E extends Env, S extends Schema, B extends string>(
        app: Hono<E, S, B>,
        mountDeps: MountDeps,
      ) => {
        const param = (c: Context, name: string) => c.req.param(name) ?? '';
        const body = async (c: Context) => {
          const parsed = (await c.req.json().catch(() => ({}))) as unknown;
          return isRecord(parsed) ? parsed : {};
        };
        const reasonOf = (c: Context, data: Record<string, unknown>) =>
          changeReasonOf(c)?.trim() || text(data.reason);

        const member = async (c: Context, right?: Right) => {
          const principal = await mountDeps.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Du er ikke logget inn') };
          const tenant = param(c, 'tenant');
          const entered = enterTenant(c, mountDeps.access, principal, tenant, right);
          if ('response' in entered) return { response: entered.response };
          return { principal: entered.principal, tenant };
        };

        const shownSubscription = async (
          guard: { principal: Principal; tenant: string },
          entry: Parameters<typeof projects.subscriptionView>[1],
        ) => {
          const view = await projects.subscriptionView(guard.tenant, entry);
          if (seesUsage(guard.principal, guard.tenant)) return view;
          const shown: Partial<typeof view> = { ...view };
          delete shown.spentThisMonth;
          return shown;
        };

        const changing = async (c: Context, right: Right) => {
          const guard = await member(c, right);
          if (guard.response) return guard;
          const data = await body(c);
          const reason = reasonOf(c, data);
          if (!reason || !isReasonLongEnough(reason))
            return {
              response: problem(c, 400, reasonTooShort, [
                { path: 'change-reason', message: reasonTooShort },
              ]),
            };
          const name = actorNameOf(c);
          return { ...guard, data, reason, ...(name ? { name } : {}) };
        };

        const inTask = async <T>(
          c: Context,
          guard: { principal: Principal; tenant: string; reason: string },
          action: (typeof projectActions)[number],
          target: string | ((value: T) => string),
          data: Record<string, unknown>,
          work: () => Promise<T>,
        ) => {
          const done = await mountDeps.admin.within(
            guard.principal,
            action,
            { tenant: guard.tenant, reason: guard.reason, ...data },
            async () => {
              const value = await work();
              return { value, target: typeof target === 'string' ? target : target(value) };
            },
          );
          c.header('genai-task', done.task);
          return done.value;
        };

        const failed = (c: Context, error: unknown) => {
          if (error instanceof AdminRefused) return refusedBy(c, error);
          if (error instanceof ProjectInvalid) return problem(c, 400, error.message, error.errors);
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

        const pointsOf = async (tenant: string, project: string) =>
          (
            (await mountDeps.configEntries.latest({
              kind: projectPointKind,
              scope: tenant,
            })) as ConfigEntry<ProjectPoint>[]
          ).filter((e) => e.spec.project === project);

        const pointView = (entry: ConfigEntry<ProjectPoint>) => ({
          id: entry.id.slice(entry.id.indexOf('/') + 1),
          text: entry.spec.text,
          by: entry.by,
          ...(entry.spec.changedBy ? { byName: entry.spec.changedBy } : {}),
          at: entry.at,
        });

        const base = '/tenants/:tenant/projects';
        const one = `${base}/:project`;
        const subscription = `${one}/subscriptions/:selection`;

        app.get(`${base}/sources`, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          return c.json({ data: await projects.sources(guard.principal, guard.tenant) });
        });

        app.get(base, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const entries = await projects.list(guard.tenant);
          const subscriptions = await projects.subscriptionsOf(guard.tenant);
          const data = await Promise.all(
            entries.map(async (entry) => {
              const own = subscriptions.filter((s) => s.spec.project === entry.id);
              const views = await Promise.all(
                own.map((s) => projects.subscriptionView(guard.tenant, s)),
              );
              return {
                ...projectView(entry),
                subscriptions: own.length,
                fresh: views.reduce((n, v) => n + v.fresh.length, 0),
                paused: views.filter((v) => v.status === 'paused').length,
                runs: (await projects.runsOf(guard.tenant, entry.id)).length,
              };
            }),
          );
          return c.json({ data });
        });

        app.post(base, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          const { errors, input } = projectInput(guard.data);
          const id = guard.data.id === undefined ? undefined : text(guard.data.id);
          if (guard.data.id !== undefined && !id)
            errors.push({ path: 'id', message: 'not a valid id' });
          if (errors.length) return problem(c, 400, 'Ugyldig prosjekt', errors);
          try {
            const saved = await inTask(
              c,
              guard,
              'platform.project.create',
              (saved) => `project:${saved.id}`,
              { name: input.name },
              () =>
                projects.create(
                  guard.principal,
                  guard.tenant,
                  { ...input, ...(id ? { id } : {}) },
                  guard.reason,
                  guard.name,
                ),
            );
            return c.json(projectView(saved), 201);
          } catch (error) {
            return failed(c, error);
          }
        });

        app.get(one, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const entry = await projects.projectOf(guard.tenant, param(c, 'project'));
          if (!entry) return problem(c, 404, 'Fant ikke prosjektet');
          const subscriptions = await Promise.all(
            (await projects.subscriptionsOf(guard.tenant, entry.id)).map((s) =>
              shownSubscription(guard, s),
            ),
          );
          return c.json({ ...projectView(entry), subscriptions });
        });

        app.put(one, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          const { errors, input } = projectInput(guard.data);
          if (errors.length) return problem(c, 400, 'Ugyldig prosjekt', errors);
          const version =
            typeof guard.data.version === 'number' && Number.isInteger(guard.data.version)
              ? guard.data.version
              : undefined;
          try {
            const saved = await inTask(
              c,
              guard,
              'platform.project.update',
              `project:${param(c, 'project')}`,
              { project: param(c, 'project') },
              () =>
                projects.update(
                  guard.principal,
                  guard.tenant,
                  param(c, 'project'),
                  input,
                  guard.reason,
                  version,
                  guard.name,
                ),
            );
            return c.json(projectView(saved));
          } catch (error) {
            return failed(c, error);
          }
        });

        app.delete(one, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          try {
            await inTask(
              c,
              guard,
              'platform.project.delete',
              `project:${param(c, 'project')}`,
              { project: param(c, 'project') },
              () =>
                projects.remove(guard.principal, guard.tenant, param(c, 'project'), guard.reason),
            );
            return c.json({ id: param(c, 'project'), deleted: true });
          } catch (error) {
            return failed(c, error);
          }
        });

        app.get(`${one}/history`, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const entries = await projects.history(guard.tenant, param(c, 'project'));
          if (entries.length === 0) return problem(c, 404, 'Fant ikke prosjektet');
          return c.json({ data: entries.map(projectView).reverse() });
        });

        app.get(`${one}/log`, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const id = param(c, 'project');
          if (!(await projects.projectOf(guard.tenant, id)))
            return problem(c, 404, 'Fant ikke prosjektet');
          const subscriptions = (
            await mountDeps.configEntries.latest({ kind: subscriptionKind, scope: guard.tenant })
          ).filter((e) => e.id.startsWith(`${id}/`));
          const runs = (
            await mountDeps.configEntries.latest({ kind: projectRunKind, scope: guard.tenant })
          ).filter((e) => (e.spec as ProjectRun).project === id);
          const entries = [
            ...(await mountDeps.configEntries.history(projectKind, guard.tenant, id)),
            ...(
              await Promise.all(
                subscriptions.map((s) =>
                  mountDeps.configEntries.history(subscriptionKind, guard.tenant, s.id),
                ),
              )
            ).flat(),
            ...runs,
            ...(await reviewHistory(mountDeps.configEntries, guard.tenant, id)),
            ...(await pointsOf(guard.tenant, id)),
          ];
          const data = entries
            .map((e) => ({
              kind: e.kind,
              id: e.id,
              version: e.version,
              deleted: e.deleted,
              by: e.by,
              ...(typeof (e.spec as { changedBy?: unknown }).changedBy === 'string' &&
              !e.by.startsWith('platform:')
                ? { byName: (e.spec as { changedBy: string }).changedBy }
                : {}),
              at: e.at,
              reason: e.reason,
            }))
            .sort((a, b) => b.at.localeCompare(a.at));
          return c.json({ data });
        });

        app.get(`${one}/points`, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const id = param(c, 'project');
          if (!(await projects.projectOf(guard.tenant, id)))
            return problem(c, 404, 'Fant ikke prosjektet');
          const data = (await pointsOf(guard.tenant, id))
            .filter((e) => !e.deleted)
            .sort((a, b) => a.at.localeCompare(b.at))
            .map(pointView);
          return c.json({ data });
        });

        app.post(`${one}/points`, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          const id = param(c, 'project');
          if (!(await projects.projectOf(guard.tenant, id)))
            return problem(c, 404, 'Fant ikke prosjektet');
          const pointText = text(guard.data.text);
          if (!pointText || pointText.length > 2000)
            return problem(c, 400, 'Skriv vurderingspunktet', [
              { path: 'text', message: 'between 1 and 2000 characters' },
            ]);
          try {
            const saved = await inTask(
              c,
              guard,
              'platform.project.point.add',
              `project:${id}/points`,
              { project: id },
              () =>
                appendVersion<ProjectPoint>(mountDeps.configEntries, {
                  kind: projectPointKind,
                  scope: guard.tenant,
                  id: `${id}/${randomUUID()}`,
                  spec: {
                    project: id,
                    text: pointText,
                    ...(guard.name ? { changedBy: guard.name } : {}),
                  },
                  deleted: false,
                  by: actorOf(guard.principal.actor ?? guard.principal),
                  reason: guard.reason,
                }),
            );
            return c.json(pointView(saved), 201);
          } catch (error) {
            return failed(c, error);
          }
        });

        app.get(`${one}/documents`, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const selection = c.req.query('selection');
          if (!selection)
            return problem(c, 400, 'Velg et utvalg', [
              { path: 'selection', message: 'a selection id is required' },
            ]);
          const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
          try {
            return c.json(
              await projects.documents(
                guard.principal,
                guard.tenant,
                param(c, 'project'),
                selection,
                limit,
              ),
            );
          } catch (error) {
            return failed(c, error);
          }
        });

        app.post(`${one}/runs/estimate`, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          const service = text(guard.data.service);
          const selection = text(guard.data.selection);
          const prompt = text(guard.data.prompt);
          if (!service || !selection)
            return problem(c, 400, 'Ugyldig forespørsel', [
              ...(service ? [] : [{ path: 'service', message: 'a service is required' }]),
              ...(selection ? [] : [{ path: 'selection', message: 'a selection is required' }]),
            ]);
          try {
            const estimate = await inTask(
              c,
              guard,
              'platform.project.run.estimate',
              `project:${param(c, 'project')}/runs`,
              { project: param(c, 'project'), service, selection },
              () =>
                projects.estimate(
                  guard.principal,
                  guard.tenant,
                  param(c, 'project'),
                  {
                    service,
                    selection,
                    ...(prompt ? { prompt } : {}),
                    sample: guard.data.sample !== false,
                  },
                  guard.reason,
                ),
            );
            return c.json({ ...estimateView(estimate), selection }, 201);
          } catch (error) {
            return failed(c, error);
          }
        });

        app.post(`${one}/runs`, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          const estimate = text(guard.data.estimate);
          if (!estimate)
            return problem(c, 400, 'Beregn kostnaden før du starter', [
              { path: 'estimate', message: 'an estimate id is required' },
            ]);
          const selection = text(guard.data.selection);
          const maxCostNok = positive(guard.data.maxCostNok);
          const maxTokens = positive(guard.data.maxTokens);
          const concurrency = positive(guard.data.concurrency);
          try {
            const started = await inTask(
              c,
              guard,
              'platform.project.run.start',
              `project:${param(c, 'project')}/runs`,
              { project: param(c, 'project'), estimate },
              () =>
                projects.start(
                  guard.principal,
                  guard.tenant,
                  param(c, 'project'),
                  {
                    estimate,
                    ...(selection ? { selection } : {}),
                    ...(maxCostNok === undefined ? {} : { maxCostNok }),
                    ...(maxTokens === undefined ? {} : { maxTokens }),
                    ...(concurrency === undefined ? {} : { concurrency }),
                  },
                  guard.reason,
                ),
            );
            background(started.done);
            const detail = await projects.batches.detail(guard.tenant, started.run);
            return c.json(runView(started.run, detail.totals), 202);
          } catch (error) {
            return failed(c, error);
          }
        });

        const linkedRun = async (tenant: string, project: string, run: string) =>
          (await projects.runsOf(tenant, project)).find((l) => l.run === run);

        app.post(`${one}/runs/:run/cancel`, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          const link = await linkedRun(guard.tenant, param(c, 'project'), param(c, 'run'));
          if (!link) return problem(c, 404, 'Fant ikke kjøringen');
          try {
            await inTask(
              c,
              guard,
              'platform.project.run.cancel',
              `project:${param(c, 'project')}/runs/${link.run}`,
              { project: param(c, 'project'), run: link.run },
              () =>
                projects.batches.cancel(
                  guard.principal,
                  guard.tenant,
                  link.service,
                  link.run,
                  guard.reason,
                ),
            );
            return c.json({ id: link.run, cancelling: true }, 202);
          } catch (error) {
            return failed(c, error);
          }
        });

        app.post(`${one}/runs/:run/retry`, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          const link = await linkedRun(guard.tenant, param(c, 'project'), param(c, 'run'));
          if (!link) return problem(c, 404, 'Fant ikke kjøringen');
          const maxCostNok = positive(guard.data.maxCostNok);
          const maxTokens = positive(guard.data.maxTokens);
          const items =
            Array.isArray(guard.data.items) && guard.data.items.every((i) => Number.isInteger(i))
              ? (guard.data.items as number[])
              : undefined;
          try {
            const retried = await inTask(
              c,
              guard,
              'platform.project.run.retry',
              `project:${param(c, 'project')}/runs/${link.run}`,
              { project: param(c, 'project'), run: link.run },
              () =>
                projects.batches.retry(
                  guard.principal,
                  guard.tenant,
                  link.service,
                  link.run,
                  {
                    ...(maxCostNok === undefined ? {} : { maxCostNok }),
                    ...(maxTokens === undefined ? {} : { maxTokens }),
                    ...(items ? { items } : {}),
                  },
                  guard.reason,
                ),
            );
            background(retried.done);
            const detail = await projects.batches.detail(guard.tenant, retried.run);
            return c.json(
              { ...runView(retried.run, detail.totals), retried: retried.retried },
              202,
            );
          } catch (error) {
            return failed(c, error);
          }
        });

        app.get(`${one}/runs`, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const id = param(c, 'project');
          if (!(await projects.projectOf(guard.tenant, id)))
            return problem(c, 404, 'Fant ikke prosjektet');
          const fresh = (
            await Promise.all(
              (await projects.subscriptionsOf(guard.tenant, id)).map((s) =>
                projects.subscriptionView(guard.tenant, s),
              ),
            )
          ).flatMap((v) => v.fresh.map((f) => ({ selection: v.selection, at: f.arrivedAt })));
          const approvals = await approvalsOf(mountDeps.configEntries, guard.tenant);
          const data = (await projects.runDetails(guard.tenant, id))
            .map(({ link, run, totals }) => {
              const approval = approvals.get(run.id);
              const view = runView(run, totals);
              return {
                ...(costVisible(guard.principal, guard.tenant, run) ? view : withoutCost(view)),
                trigger: link.trigger,
                ...(link.selection ? { selection: link.selection } : {}),
                newSince: fresh.filter(
                  (f) => f.selection === link.selection && f.at > run.startedAt,
                ).length,
                ...(approval ? { approval } : {}),
              };
            })
            .sort(
              (a, b) =>
                Number(b.approval?.status === 'pending') - Number(a.approval?.status === 'pending'),
            );
          return c.json({ data });
        });

        app.post(`${one}/runs/:run/review`, async (c) => {
          const guard = await changing(c, 'use-services');
          if (guard.response) return guard.response;
          const decision = guard.data.decision;
          if (decision !== 'approved' && decision !== 'rejected')
            return problem(c, 400, 'Ugyldig forespørsel', [
              { path: 'decision', message: 'decision is approved or rejected' },
            ]);
          const project = param(c, 'project');
          const runId = param(c, 'run');
          const link = (await projects.runsOf(guard.tenant, project)).find((l) => l.run === runId);
          if (!link) return problem(c, 404, 'Fant ikke kjøringen');
          if (link.trigger !== 'subscription')
            return problem(c, 409, 'Kjøringen er startet av en person og trenger ikke godkjenning');
          const run = await projects.batches.runOf(guard.tenant, link.service, link.run);
          if (run && (run.status === 'queued' || run.status === 'running'))
            return problem(c, 409, 'Vent til kjøringen er ferdig før du godkjenner den');
          try {
            await inTask(
              c,
              guard,
              'platform.project.run.review',
              `project:${project}/runs/${runId}`,
              { project, run: runId, decision },
              () =>
                recordReview(
                  mountDeps.configEntries,
                  guard.tenant,
                  {
                    project,
                    run: runId,
                    decision: decision as ReviewDecision,
                    ...(guard.name ? { changedBy: guard.name } : {}),
                  },
                  actorOf(guard.principal.actor ?? guard.principal),
                  guard.reason,
                ),
            );
          } catch (error) {
            return failed(c, error);
          }
          const approval = (await approvalsOf(mountDeps.configEntries, guard.tenant)).get(runId);
          return c.json({ run: runId, ...approval, project });
        });

        app.get(`${one}/subscriptions`, async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const id = param(c, 'project');
          if (!(await projects.projectOf(guard.tenant, id)))
            return problem(c, 404, 'Fant ikke prosjektet');
          const data = await Promise.all(
            (await projects.subscriptionsOf(guard.tenant, id)).map((s) =>
              shownSubscription(guard, s),
            ),
          );
          return c.json({ data });
        });

        const modeOf = (value: unknown): SubscriptionMode | undefined =>
          value === 'notify' || value === 'run' ? value : undefined;

        app.put(subscription, async (c) => {
          const peek = (await c.req.raw
            .clone()
            .json()
            .catch(() => ({}))) as unknown;
          const mode = modeOf(isRecord(peek) ? peek.mode : undefined);
          if (!mode)
            return problem(c, 400, 'Velg om tjenesten skal kjøres automatisk', [
              { path: 'mode', message: 'mode is notify or run' },
            ]);
          const guard = await changing(c, mode === 'run' ? 'manage-services' : 'use-services');
          if (guard.response) return guard.response;
          const service = text(guard.data.service);
          const prompt = text(guard.data.prompt);
          const maxCostNok = positive(guard.data.maxCostNok);
          const maxTokens = positive(guard.data.maxTokens);
          try {
            const saved = await inTask(
              c,
              guard,
              'platform.project.subscription.save',
              `project:${param(c, 'project')}/subscriptions/${param(c, 'selection')}`,
              { project: param(c, 'project'), selection: param(c, 'selection'), mode },
              () =>
                projects.subscribe(
                  guard.principal,
                  guard.tenant,
                  param(c, 'project'),
                  param(c, 'selection'),
                  {
                    mode,
                    ...(service ? { service } : {}),
                    ...(prompt ? { prompt } : {}),
                    ...(maxCostNok === undefined ? {} : { maxCostNok }),
                    ...(maxTokens === undefined ? {} : { maxTokens }),
                  },
                  guard.reason,
                  guard.name,
                ),
            );
            return c.json(await shownSubscription(guard, saved));
          } catch (error) {
            return failed(c, error);
          }
        });

        const modeFor = async (c: Context): Promise<SubscriptionMode> => {
          const entries = await projects.subscriptionsOf(param(c, 'tenant'), param(c, 'project'));
          const found = entries.find((e) => e.spec.selection === param(c, 'selection'));
          return found?.spec.mode === 'run' ? 'run' : 'notify';
        };
        const rightOf = (mode: SubscriptionMode): Right =>
          mode === 'run' ? 'manage-services' : 'use-services';
        const subscriptionOf = (c: Context, mode: SubscriptionMode) => ({
          target: `project:${param(c, 'project')}/subscriptions/${param(c, 'selection')}`,
          data: { project: param(c, 'project'), selection: param(c, 'selection'), mode },
        });

        app.delete(subscription, async (c) => {
          const mode = await modeFor(c);
          const guard = await changing(c, rightOf(mode));
          if (guard.response) return guard.response;
          const { target, data } = subscriptionOf(c, mode);
          try {
            await inTask(c, guard, 'platform.project.subscription.delete', target, data, () =>
              projects.unsubscribe(
                guard.principal,
                guard.tenant,
                param(c, 'project'),
                param(c, 'selection'),
                guard.reason,
              ),
            );
            return c.json({ selection: param(c, 'selection'), deleted: true });
          } catch (error) {
            return failed(c, error);
          }
        });

        for (const [action, paused] of [
          ['pause', true],
          ['resume', false],
        ] as const)
          app.post(`${subscription}/${action}`, async (c) => {
            const mode = await modeFor(c);
            const guard = await changing(c, rightOf(mode));
            if (guard.response) return guard.response;
            const { target, data } = subscriptionOf(c, mode);
            try {
              const saved = await inTask(
                c,
                guard,
                `platform.project.subscription.${action}`,
                target,
                data,
                () =>
                  projects.setPaused(
                    guard.principal,
                    guard.tenant,
                    param(c, 'project'),
                    param(c, 'selection'),
                    paused,
                    guard.reason,
                  ),
              );
              if (!paused)
                projects.checkInBackground(guard.tenant, saved.id, 'Abonnementet fortsetter');
              return c.json(await shownSubscription(guard, saved));
            } catch (error) {
              return failed(c, error);
            }
          });

        app.post(`${subscription}/check`, async (c) => {
          const mode = await modeFor(c);
          const guard = await member(c, rightOf(mode));
          if (guard.response) return guard.response;
          const key = `${param(c, 'project')}/${param(c, 'selection')}`;
          const { target, data } = subscriptionOf(c, mode);
          try {
            const result = await inTask(
              c,
              { ...guard, reason: 'Sjekket nå' },
              'platform.project.subscription.check',
              target,
              data,
              () => projects.check(guard.tenant, key, 'Sjekket nå'),
            );
            if (result.done) background(result.done);
            if (result.status === 'off') return problem(c, 404, 'Fant ikke abonnementet');
            const shown: Partial<typeof result> = { ...result };
            delete shown.done;
            return c.json(shown);
          } catch (error) {
            return failed(c, error);
          }
        });
      },
    };
  };

export const projectsModule = createProjectsModule();
