import { randomUUID } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import type { PolicyDecisionPoint } from '@genai/kernel';
import { caseTypeOf, type TestSet } from '@genai/eval';
import { residencyAllows, type Residency } from '@genai/port-model';
import type { Context } from 'hono';
import { actorOf, AdminRefused, refusedBy, routeOnly } from './admin.js';
import {
  backgroundLeases,
  restartMessage,
  type Leased,
  type LeaseOptions,
} from './background-lease.js';
import type { CatalogRegistry } from './catalog-registry.js';
import { appendVersion, platformScope, type ConfigEntry } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { candidateRelease, isCandidate } from './model-access.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import {
  serviceEval,
  serviceRunKind,
  type Outcome,
  type RunStatus,
  type ServiceRun,
} from './service-eval.js';

export const matrixRunKind = 'model-matrix-run';
export const maxDropPoints = 3;
export const matrixRunAction = 'platform.quality.matrix.run';

const answerTokens = { input: 2000, output: 400 };
const judgeTokens = { input: 1200, output: 150 };

export interface MatrixScore {
  score: number | null;
  passed: number;
  total: number;
}

export interface MatrixRow {
  tenant: string;
  service: string;
  name: string;
  testSet: string;
  testSetVersion: number;
  cases: number;
  current: MatrixScore | null;
  candidate: MatrixScore | null;
}

export interface MatrixRun extends Leased {
  id: string;
  model: string;
  current: string;
  status: RunStatus;
  by: string;
  startedAt: string;
  endedAt: string | null;
  estimatedCostNok: number;
  cost: number | null;
  tokens: { input: number; output: number };
  rows: MatrixRow[];
  error?: string;
}

interface Planned {
  tenant: string;
  service: string;
  name: string;
  set: TestSet;
  definition: Record<string, unknown>;
  files: Record<string, string>;
  version: number;
}

type Status = 400 | 401 | 403 | 404 | 409;
type Problem = { path: string; message: string };

const problem = (
  c: Context,
  status: Status,
  title: string,
  errors: Problem[] = [],
  extra: Record<string, unknown> = {},
) =>
  c.json({ type: 'about:blank', title, status, errors, ...extra }, status, {
    'content-type': 'application/problem+json',
  });

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const points = (score: MatrixScore | null | undefined) =>
  score?.score == null ? null : Math.round(score.score * 100);

const scoreOf = (outcome: Outcome): MatrixScore => ({
  score: outcome.score,
  passed: outcome.passed,
  total: outcome.total,
});

const modelSpec = (definition: Record<string, unknown>) =>
  record(record(definition.spec).model) as {
    primary?: string;
    fallback?: string;
    residency?: Residency;
    roles?: Record<string, string>;
  };

const modelsIn = (definition: Record<string, unknown>) => {
  const model = modelSpec(definition);
  return [model.primary, model.fallback, ...Object.values(model.roles ?? {})].filter(
    (m): m is string => typeof m === 'string',
  );
};

const withModel = (definition: Record<string, unknown>, current: string, model: string) => {
  const copy = structuredClone(definition);
  const spec = record(copy.spec);
  const served = { ...modelSpec(copy), primary: model };
  delete served.fallback;
  if (served.roles)
    served.roles = Object.fromEntries(
      Object.entries(served.roles).map(([role, id]) => [role, id === current ? model : id]),
    );
  spec.model = served;
  return copy;
};

export const minimumReasonWithoutMatrix = 20;

const matrixSubject = 'quality-matrix';

export const matrixPrincipal = (tenant: string): Principal => ({
  kind: 'agency-system',
  issuer: 'platform',
  subject: matrixSubject,
  tenant,
});

export const isMatrixPrincipal = (principal: Principal) =>
  principal.kind === 'agency-system' &&
  principal.issuer === 'platform' &&
  principal.subject === matrixSubject;

export const releaseGate = (
  inner: PolicyDecisionPoint,
  catalog: () => Pick<CatalogRegistry, 'get'> | undefined,
): PolicyDecisionPoint => ({
  decide: async (principal, action, resource) => {
    if (isMatrixPrincipal(principal))
      return action === 'invoke' && !resource.id.startsWith('platform/draft/')
        ? { allow: false, reason: 'the quality matrix only runs draft services' }
        : { allow: true };
    const gate = catalog();
    if (action === 'use:model' && gate && isCandidate(gate, resource.id))
      return {
        allow: false,
        reason: `model ${resource.id} is not released yet; it is waiting for the quality matrix`,
      };
    return inner.decide(principal, action, resource);
  },
});

export const regressionsOf = (run: MatrixRun) =>
  run.rows.flatMap((row) => {
    const before = points(row.current);
    const after = points(row.candidate);
    if (before === null || after === null || after - before >= -maxDropPoints) return [];
    return [{ row, drop: before - after }];
  });

export const runView = (run: MatrixRun) => ({
  id: run.id,
  model: run.model,
  current: run.current,
  status: run.status,
  by: run.by,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
  estimatedCostNok: run.estimatedCostNok,
  costNok: run.cost === null ? null : run.cost / 1_000_000,
  testSets: run.rows.length,
  done: run.rows.filter((r) => r.candidate !== null).length,
  ...(run.error ? { error: run.error } : {}),
});

export const createModelMatrixModule =
  (
    options: { onBackground?: (work: Promise<void>) => void; leases?: LeaseOptions } = {},
  ): PlatformModuleFactory =>
  (deps) => {
    const evals = serviceEval(deps, options.leases);
    const { choice } = evals;
    const leases = backgroundLeases(options.leases);
    let mounted: MountDeps | undefined;
    const background = (work: Promise<void>) => {
      work.catch(() => undefined);
      options.onBackground?.(work);
    };

    const save = (actor: string, run: MatrixRun, reason: string, ifVersion?: number) =>
      appendVersion<MatrixRun>(deps.configEntries, {
        kind: matrixRunKind,
        scope: platformScope,
        id: run.id,
        spec: run,
        deleted: false,
        by: actor,
        reason,
        ...(ifVersion === undefined ? {} : { ifVersion }),
      });

    const settled = async (entry: ConfigEntry<MatrixRun>) => {
      const run = entry.spec;
      if (run.status !== 'queued' && run.status !== 'running') return run;
      if (!leases.abandoned(`matrix/${run.id}`, run, run.startedAt)) return run;
      const failed: MatrixRun = {
        ...run,
        status: 'failed',
        endedAt: leases.now().toISOString(),
        error: restartMessage,
      };
      await save('platform:restart', failed, restartMessage, entry.version).catch(() => undefined);
      return failed;
    };

    const runs = async () =>
      (
        await Promise.all(
          (await deps.configEntries.latest({ kind: matrixRunKind, scope: platformScope })).map(
            (e) => settled(e as ConfigEntry<MatrixRun>),
          ),
        )
      ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const latestSucceeded = async (model: string) =>
      (await runs()).find((r) => r.model === model && r.status === 'succeeded');

    const known = (model: string) => deps.models.describe().find((m) => m.id === model);

    const plan = async (model: string, current: string): Promise<Planned[]> => {
      const residency = known(model)?.residency;
      if (!residency) return [];
      const planned: Planned[] = [];
      const seen = new Set<string>();
      for (const cap of await deps.definitions.capabilities()) {
        const { tenant, id } = cap.service;
        if (seen.has(`${tenant}/${id}`)) continue;
        seen.add(`${tenant}/${id}`);
        const found = await deps.definitions.get('Service', tenant, id);
        if (!found) continue;
        const definition = structuredClone(found.definition) as unknown as Record<string, unknown>;
        const served = modelSpec(definition);
        if (served.primary !== current) continue;
        if (!residencyAllows(served.residency ?? 'global', residency)) continue;
        const name = text(record(definition.metadata).name) ?? id;
        for (const set of await deps.evalStores.testSets.list(tenant, id))
          if (set.spec.cases.length > 0)
            planned.push({
              tenant,
              service: id,
              name,
              set,
              definition,
              files: { ...found.files },
              version: found.version,
            });
      }
      return planned;
    };

    const tokensPerCase = async (tenant: string, service: string) => {
      const last = (await deps.configEntries.latest({ kind: serviceRunKind, scope: tenant }))
        .map((e) => e.spec as ServiceRun)
        .filter((r) => r.service === service && r.status === 'succeeded' && r.total > 0)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      return last
        ? {
            input: Math.ceil(last.tokens.input / last.total),
            output: Math.ceil(last.tokens.output / last.total),
          }
        : answerTokens;
    };

    const priceOf = (model: string, tokens: { input: number; output: number }) => {
      const price = deps.prices[model];
      return price
        ? (tokens.input * price.inputPerThousand + tokens.output * price.outputPerThousand) / 1000
        : undefined;
    };

    const estimate = async (model: string, current: string, planned: Planned[]) => {
      const unpriced = new Set<string>();
      let nok = 0;
      let cases = 0;
      const add = (id: string, tokens: { input: number; output: number }, count: number) => {
        const each = priceOf(id, tokens);
        if (each === undefined) unpriced.add(id);
        else nok += each * count;
      };
      for (const row of planned) {
        const all = row.set.spec.cases.length;
        const criteria = row.set.spec.cases.filter((c) => caseTypeOf(c) === 'criteria').length;
        const judge = criteria
          ? choice.pickJudge(await choice.usable(deps.platformTenant), deps.platformTenant, [
              model,
              current,
            ])
          : undefined;
        const tokens = await tokensPerCase(row.tenant, row.service);
        for (const served of [current, model]) {
          cases += all;
          add(served, tokens, all);
          if (judge) add(judge, judgeTokens, criteria);
        }
      }
      return {
        model,
        current,
        testSets: planned.map((row) => ({
          tenant: row.tenant,
          service: row.service,
          name: row.name,
          testSet: row.set.metadata.id,
          cases: row.set.spec.cases.length,
        })),
        cases,
        estimatedCostNok: Math.ceil(nok * 100) / 100,
        unpriced: [...unpriced].sort(),
      };
    };

    const execute = async (
      principal: Principal,
      run: MatrixRun,
      planned: Planned[],
      reason: string,
    ) => {
      const actor = actorOf(principal.actor ?? principal);
      const lease = leases.hold(`matrix/${run.id}`, run, (spec, reason) =>
        save(actor, spec, reason),
      );
      try {
        await lease.update((r) => r, reason);
      } catch (error) {
        lease.release();
        throw error;
      }
      const done = (async () => {
        const meter = choice.meter();
        const metered = (r: MatrixRun): MatrixRun => ({
          ...r,
          cost: meter.costMicroNok(),
          tokens: { input: meter.inputTokens, output: meter.outputTokens },
        });
        try {
          await lease.update((r) => ({ ...r, status: 'running' }), 'Kjører');
          for (const [index, row] of planned.entries()) {
            const acting = matrixPrincipal(deps.platformTenant);
            const cases = row.set.spec.cases;
            const options = {
              avoidAsJudge: [run.model, run.current],
              chargeTo: deps.platformTenant,
            };
            const before = await evals.runCases(
              acting,
              row.tenant,
              { definition: row.definition, files: row.files, version: row.version },
              cases,
              meter,
              options,
            );
            const after = await evals.runCases(
              acting,
              row.tenant,
              {
                definition: withModel(row.definition, run.current, run.model),
                files: row.files,
                version: 'draft',
              },
              cases,
              meter,
              options,
            );
            await lease.update(
              (r) =>
                metered({
                  ...r,
                  rows: r.rows.map((x, i) =>
                    i === index ? { ...x, current: scoreOf(before), candidate: scoreOf(after) } : x,
                  ),
                }),
              `Testsett ${index + 1} av ${planned.length}`,
            );
          }
          await lease.update(
            (r) => metered({ ...r, status: 'succeeded', endedAt: new Date().toISOString() }),
            'Ferdig',
          );
        } catch (error) {
          await lease.update(
            (r) =>
              metered({
                ...r,
                status: 'failed',
                endedAt: new Date().toISOString(),
                error: messageOf(error),
              }),
            'Feilet',
          );
        } finally {
          lease.release();
        }
      })();
      return { done };
    };

    const tenantNames = async () =>
      (await mounted?.admin.tenantNames().catch(() => undefined)) ?? new Map<string, string>();

    const matrixOf = async (all: MatrixRun[]) => {
      const latest = new Map<string, MatrixRun>();
      for (const run of all)
        if (run.status === 'succeeded' && !latest.has(run.model)) latest.set(run.model, run);
      const chosen = [...latest.values()].reverse();
      if (chosen.length === 0) return undefined;
      const names = await tenantNames();
      const currents = [...new Set(chosen.map((r) => r.current))];
      const columns = [
        ...currents.map((name) => ({ name, status: 'in_use' as const })),
        ...chosen.map((r) => ({
          name: r.model,
          status: isCandidate(deps.catalog, r.model) ? ('new' as const) : ('allowed' as const),
        })),
      ];
      const baseline = [
        ...currents.map((_, i) => i),
        ...chosen.map((r) => currents.indexOf(r.current)),
      ];
      const keyOf = (row: MatrixRow) => `${row.tenant}/${row.service}/${row.testSet}`;
      const keys = new Map<string, MatrixRow>();
      for (const run of chosen)
        for (const row of run.rows) if (!keys.has(keyOf(row))) keys.set(keyOf(row), row);
      const rows = [...keys.entries()].map(([key, row]) => {
        const find = (run: MatrixRun) => run.rows.find((x) => keyOf(x) === key);
        return {
          testSet: `${row.name} · ${names.get(row.tenant) ?? row.tenant}`,
          kind: 'Delt testsett',
          scores: [
            ...currents.map(
              (current) =>
                chosen
                  .filter((r) => r.current === current)
                  .map((r) => points(find(r)?.current))
                  .find((p) => p !== null) ?? null,
            ),
            ...chosen.map((r) => points(find(r)?.candidate)),
          ],
        };
      });
      return {
        models: { columns, baseline, rows },
        blocks: { columns: [], baseline: [], rows: [] },
      };
    };

    const inUse = async () => {
      const counts = new Map<string, number>();
      const seen = new Set<string>();
      for (const cap of await deps.definitions.capabilities()) {
        const key = `${cap.service.tenant}/${cap.service.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const primary = text(record(record(cap.capability.config).model).primary);
        if (primary) counts.set(primary, (counts.get(primary) ?? 0) + 1);
      }
      return [...counts.entries()]
        .map(([id, services]) => ({ id, services }))
        .sort((a, b) => b.services - a.services || a.id.localeCompare(b.id));
    };

    const affectedTestSets = async (model: string) => {
      let count = 0;
      for (const used of await inUse())
        if (used.id !== model) count += (await plan(model, used.id)).length;
      return count;
    };

    const qualityOverview = async () => {
      const all = await runs();
      const matrix = await matrixOf(all);
      const candidates = deps.catalog
        .list({ kind: 'model', scope: platformScope })
        .filter((item) => item.spec.release === candidateRelease);
      return {
        ...(matrix ? { matrix } : {}),
        matrixRuns: all.slice(0, 20).map(runView),
        candidates: await Promise.all(
          candidates.map(async (item) => ({
            id: item.id,
            residency: item.spec.residency ?? null,
            testSets: await affectedTestSets(item.id),
          })),
        ),
        modelsInUse: await inUse(),
      };
    };

    const checkPublish = async (definition: unknown) => {
      const d = record(definition);
      if (d.kind !== 'Service') return [];
      return modelsIn(d)
        .filter((m) => isCandidate(deps.catalog, m))
        .map((m) => ({
          path: 'spec.model',
          message: `model ${m} is not released yet; it is waiting for the quality matrix`,
        }));
    };

    background(runs().then(() => undefined));

    return {
      id: 'model-matrix',
      handlers: { [matrixRunAction]: routeOnly },
      checkPublish,
      qualityOverview,
      mount: (app, mountDeps) => {
        mounted = mountDeps;
        const operator = async (c: Context) => {
          const principal = await mountDeps.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Unauthorized') };
          if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
          return { principal: { ...principal, tenant: deps.platformTenant } };
        };
        const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';
        const body = async (c: Context) => record(await c.req.json().catch(() => ({})));
        const pair = (c: Context, input: Record<string, unknown>) => {
          const model = text(input.model);
          const current = text(input.current);
          const errors: Problem[] = [
            ...(model ? [] : [{ path: 'model', message: 'the model to test is required' }]),
            ...(current ? [] : [{ path: 'current', message: 'the model in use is required' }]),
            ...(model && model === current
              ? [{ path: 'current', message: 'compare against another model' }]
              : []),
          ];
          if (errors.length > 0 || !model || !current)
            return { response: problem(c, 400, 'Invalid request', errors) };
          const missing = [model, current].filter((m) => !known(m));
          if (missing.length > 0)
            return {
              response: problem(
                c,
                404,
                'Fant ikke modellen',
                missing.map((m) => ({ path: m === model ? 'model' : 'current', message: m })),
              ),
            };
          if (!known(model)?.enabled)
            return {
              response: problem(c, 409, 'Modellen er slått av', [
                { path: 'model', message: `${model} is turned off` },
              ]),
            };
          return { model, current };
        };

        app.post('/operator/quality/matrix/estimate', async (c) => {
          const guard = await operator(c);
          if ('response' in guard) return guard.response;
          const chosen = pair(c, await body(c));
          if ('response' in chosen) return chosen.response;
          const planned = await plan(chosen.model, chosen.current);
          return c.json(await estimate(chosen.model, chosen.current, planned));
        });

        app.post('/operator/quality/matrix/runs', async (c) => {
          const guard = await operator(c);
          if ('response' in guard) return guard.response;
          const reason = reasonOf(c);
          if (!isReasonLongEnough(reason))
            return problem(c, 400, 'Invalid request', [
              { path: 'change-reason', message: reasonTooShort },
            ]);
          const input = await body(c);
          const chosen = pair(c, input);
          if ('response' in chosen) return chosen.response;
          const { model, current } = chosen;
          if (
            (await runs()).some(
              (r) => r.model === model && ['queued', 'running'].includes(r.status),
            )
          )
            return problem(c, 409, 'Kvalitetsmatrisen kjører allerede for modellen', [
              { path: 'model', message: `a run for ${model} is in progress` },
            ]);
          const planned = await plan(model, current);
          if (planned.length === 0)
            return problem(c, 409, 'Ingen testsett å kjøre', [
              { path: 'current', message: `no service using ${current} has a test set` },
            ]);
          const priced = await estimate(model, current, planned);
          const confirmed = input.confirmedCostNok;
          if (typeof confirmed !== 'number' || confirmed < priced.estimatedCostNok)
            return problem(
              c,
              409,
              'Bekreft den beregnede kostnaden',
              [{ path: 'confirmedCostNok', message: `confirm ${priced.estimatedCostNok} NOK` }],
              { estimate: priced },
            );
          const queued: MatrixRun = {
            id: randomUUID(),
            model,
            current,
            status: 'queued',
            by: actorOf(guard.principal),
            startedAt: new Date().toISOString(),
            endedAt: null,
            estimatedCostNok: priced.estimatedCostNok,
            cost: null,
            tokens: { input: 0, output: 0 },
            rows: planned.map((row) => ({
              tenant: row.tenant,
              service: row.service,
              name: row.name,
              testSet: row.set.metadata.id,
              testSetVersion: row.set.metadata.version,
              cases: row.set.spec.cases.length,
              current: null,
              candidate: null,
            })),
            ...leases.stamp(),
          };
          try {
            const started = await mountDeps.admin.within(
              guard.principal,
              matrixRunAction,
              { tenant: deps.platformTenant, reason, model, current, run: queued.id },
              async () => ({
                value: await execute(guard.principal, queued, planned, reason),
                target: `matrix-run:${queued.id}`,
              }),
            );
            c.header('genai-task', started.task);
            background(started.value.done);
          } catch (error) {
            if (error instanceof AdminRefused) return refusedBy(c, error);
            throw error;
          }
          return c.json(runView(queued), 202);
        });

        app.get('/operator/quality/matrix/runs/:id', async (c) => {
          const guard = await operator(c);
          if ('response' in guard) return guard.response;
          const entry = (
            await deps.configEntries.history(matrixRunKind, platformScope, c.req.param('id') ?? '')
          ).at(-1) as ConfigEntry<MatrixRun> | undefined;
          if (!entry) return problem(c, 404, 'Not found');
          const run = await settled(entry);
          return c.json({ ...runView(run), rows: run.rows });
        });

        app.post('/operator/quality/matrix/release', async (c) => {
          const guard = await operator(c);
          if ('response' in guard) return guard.response;
          const reason = reasonOf(c);
          if (!isReasonLongEnough(reason))
            return problem(c, 400, 'Invalid request', [
              { path: 'change-reason', message: reasonTooShort },
            ]);
          const input = await body(c);
          if (input.kind !== undefined && input.kind !== 'models')
            return problem(c, 400, 'Invalid request', [
              { path: 'kind', message: 'the quality matrix releases models' },
            ]);
          const model = text(input.name) ?? text(input.model) ?? '';
          const item = deps.catalog.get('model', model);
          if (!item || item.scope !== platformScope) return problem(c, 404, 'Fant ikke modellen');
          if (item.spec.release !== candidateRelease)
            return problem(c, 409, 'Modellen er allerede tilgjengelig', [
              { path: 'name', message: `${model} is released` },
            ]);
          const run = await latestSucceeded(model);
          if (!run && (await affectedTestSets(model)) > 0)
            return problem(c, 409, 'Kvalitetsmatrisen er ikke kjørt for modellen', [
              { path: 'name', message: `run the quality matrix for ${model} first` },
            ]);
          if (!run && reason.length < minimumReasonWithoutMatrix)
            return problem(c, 400, 'Begrunnelsen er for kort', [
              {
                path: 'reason',
                message: `Begrunnelsen må ha minst ${minimumReasonWithoutMatrix} tegn.`,
              },
            ]);
          const worse = run ? regressionsOf(run) : [];
          if (worse.length > 0)
            return problem(
              c,
              409,
              'Modellen kan ikke tillates: minst ett testsett er mer enn 3 poeng dårligere',
              worse.map(({ row, drop }) => ({
                path: `testSets.${row.tenant}/${row.service}/${row.testSet}`,
                message: `${drop} points worse than ${run?.current ?? ''}`,
              })),
              { run: run?.id },
            );
          const result = await mountDeps.admin.perform(
            guard.principal,
            'platform.catalog.publish',
            {
              kind: 'model',
              id: model,
              spec: item.spec,
              scope: platformScope,
              tenant: deps.platformTenant,
              reason,
              release: true,
              matrixRun: run?.id ?? false,
            },
          );
          c.header('genai-task', result.task);
          if (!result.ok) return problem(c, 400, 'Invalid request', result.errors);
          return c.json({ model, released: true, run: run?.id ?? null });
        });
      },
    };
  };

export const modelMatrixModule: PlatformModuleFactory = createModelMatrixModule();
