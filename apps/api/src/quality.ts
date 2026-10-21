import { randomBytes } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import {
  caseFrom,
  caseView,
  isCaseSplit,
  isCaseType,
  testCase,
  type CaseSplit,
  type TestSet,
} from '@genai/eval';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant } from './access.js';
import { AdminRefused, refusedBy, routeOnly } from './admin.js';
import type { LeaseOptions } from './background-lease.js';
import { VersionConflict, type ConfigEntry } from './config-store.js';
import { changeReasonOf } from './http.js';
import { improvements, improvementView } from './improvements.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { rightsOf, type Right } from './rights.js';
import { runSummary, runView, serviceEval, type ServiceDraft } from './service-eval.js';

type Status = 400 | 401 | 403 | 404 | 409 | 422;

const problem = (c: Context, status: Status, title: string, errors: unknown[] = []) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const variantIdsOf = (definition: Record<string, unknown>) => {
  const variants = isRecord(definition.spec) ? definition.spec.variants : undefined;
  return Array.isArray(variants)
    ? variants.map((v) => (typeof v === 'string' ? v : isRecord(v) ? String(v.id) : ''))
    : [];
};

const slug = /^[a-z0-9][a-z0-9-]*$/;

const splitCounts = (set: TestSet) => {
  const counts: Record<CaseSplit, number> = { locked: 0, open: 0 };
  for (const c of set.spec.cases) counts[caseView(c).split] += 1;
  return counts;
};

const setSummary = (set: TestSet) => {
  const splits = splitCounts(set);
  const only: CaseSplit | undefined =
    set.spec.cases.length === 0
      ? undefined
      : splits.locked === 0
        ? 'open'
        : splits.open === 0
          ? 'locked'
          : undefined;
  return {
    id: set.metadata.id,
    name: set.metadata.name,
    version: set.metadata.version,
    cases: set.spec.cases.length,
    splits,
    ...(only ? { split: only } : {}),
  };
};

export const serviceDraftActions = [
  'platform.service.draft.save',
  'platform.service.draft.rebase',
  'platform.service.draft.delete',
] as const;

export const createQualityModule =
  (
    options: { onBackground?: (work: Promise<void>) => void; leases?: LeaseOptions } = {},
  ): PlatformModuleFactory =>
  (deps) => {
    const evals = serviceEval(deps, options.leases);
    const improving = improvements(deps, evals);
    const background = (work: Promise<void>) => {
      work.catch(() => undefined);
      options.onBackground?.(work);
    };
    background(evals.recoverRuns());
    background(improving.recover());

    return {
      id: 'quality',
      handlers: {
        ...Object.fromEntries(serviceDraftActions.map((action) => [action, routeOnly])),
        ...improving.handlers,
      },
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

        const member = async (c: Context, right?: Right) => {
          const principal = await mountDeps.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Du er ikke logget inn') };
          const tenant = param(c, 'tenant');
          const entered = enterTenant(c, mountDeps.access, principal, tenant, right);
          if ('response' in entered) return { response: entered.response };
          return { principal: entered.principal, tenant };
        };

        const inTask = async <T>(
          c: Context,
          guard: { principal: Principal; tenant: string },
          action: (typeof serviceDraftActions)[number],
          service: string,
          reason: string,
          work: () => Promise<T>,
        ) => {
          const done = await mountDeps.admin.within(
            guard.principal,
            action,
            { tenant: guard.tenant, reason, service },
            async () => ({ value: await work(), target: `service-draft:${service}` }),
          );
          c.header('genai-task', done.task);
          return done.value;
        };

        const draftFailed = (c: Context, error: unknown) => {
          if (error instanceof VersionConflict)
            return problem(c, 409, 'Konflikt', [{ path: 'revision', message: error.message }]);
          if (error instanceof AdminRefused) return refusedBy(c, error);
          throw error;
        };

        const draftView = async (
          tenant: string,
          service: string,
          draft: ConfigEntry<ServiceDraft>,
        ) => ({
          revision: draft.version,
          definition: draft.spec.definition,
          files: draft.spec.files,
          baseVersion: draft.spec.baseVersion ?? null,
          latestVersion: (await evals.drafts.latestVersion(tenant, service)) ?? null,
          at: draft.at,
          reason: draft.reason,
        });

        const openedDraft = async (
          c: Context,
          guard: { principal: Principal; tenant: string },
          service: string,
          draft: ConfigEntry<ServiceDraft>,
        ) => {
          const latest = (await evals.drafts.latestVersion(guard.tenant, service)) ?? 0;
          const baseVersion = draft.spec.baseVersion;
          const behind = baseVersion !== undefined && baseVersion < latest;
          if (
            !behind ||
            !rightsOf(guard.principal, guard.tenant).has('manage-services') ||
            deps.readOnly?.(guard.principal)
          )
            return { ...(await draftView(guard.tenant, service, draft)), behind, conflicts: [] };
          const reason = reasonOf(c) || 'Utkast oppdatert med publiserte endringer';
          const rebased = await inTask(
            c,
            guard,
            'platform.service.draft.rebase',
            service,
            reason,
            () =>
              evals.drafts.rebase(
                guard.principal,
                guard.tenant,
                service,
                reason,
                draft.version,
                true,
              ),
          );
          if (!rebased?.applied)
            return {
              ...(await draftView(guard.tenant, service, draft)),
              behind,
              conflicts: rebased?.conflicts ?? [],
            };
          return {
            ...(await draftView(guard.tenant, service, rebased.entry)),
            behind: false,
            conflicts: [],
            rebasedFrom: baseVersion,
          };
        };

        // 200 with a JSON null body when the service has no draft
        app.get('/tenants/:tenant/services/:id/draft', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const service = param(c, 'id');
          const draft = await evals.draftOf(guard.tenant, service);
          if (!draft) return c.json(null);
          if (c.req.query('rebase') !== 'clean')
            return c.json(await draftView(guard.tenant, service, draft));
          try {
            return c.json(await openedDraft(c, guard, service, draft));
          } catch (error) {
            return draftFailed(c, error);
          }
        });

        app.put('/tenants/:tenant/services/:id/draft', async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          if (!isRecord(data.definition))
            return problem(c, 400, 'Ugyldig forespørsel', [
              { path: 'definition', message: 'a definition is required' },
            ]);
          const service = param(c, 'id');
          const latest = (await evals.drafts.latestVersion(guard.tenant, service)) ?? 0;
          const baseVersion = data.baseVersion;
          if (
            baseVersion !== undefined &&
            !(
              Number.isInteger(baseVersion) &&
              Number(baseVersion) >= 0 &&
              Number(baseVersion) <= latest
            )
          )
            return problem(c, 400, 'Ugyldig forespørsel', [
              {
                path: 'baseVersion',
                message: `baseVersion is a published version from 0 to ${latest}`,
              },
            ]);
          const metadata = isRecord(data.definition.metadata) ? data.definition.metadata : {};
          const draft: ServiceDraft = {
            definition: {
              ...data.definition,
              metadata: { ...metadata, tenant: guard.tenant, id: service },
            },
            files: isRecord(data.files)
              ? Object.fromEntries(
                  Object.entries(data.files).filter(
                    (e): e is [string, string] => typeof e[1] === 'string',
                  ),
                )
              : {},
            ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
          };
          const reason = reasonOf(c);
          try {
            const saved = await inTask(
              c,
              guard,
              'platform.service.draft.save',
              service,
              reason,
              () =>
                evals.saveDraft(
                  guard.principal,
                  guard.tenant,
                  service,
                  draft,
                  reason,
                  typeof data.revision === 'number' ? data.revision : undefined,
                ),
            );
            return c.json(await draftView(guard.tenant, service, saved));
          } catch (error) {
            return draftFailed(c, error);
          }
        });

        app.post('/tenants/:tenant/services/:id/draft/rebase', async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          const service = param(c, 'id');
          const reason = reasonOf(c);
          try {
            const rebased = await inTask(
              c,
              guard,
              'platform.service.draft.rebase',
              service,
              reason,
              () =>
                evals.drafts.rebase(
                  guard.principal,
                  guard.tenant,
                  service,
                  reason,
                  typeof data.revision === 'number' ? data.revision : undefined,
                  data.onlyIfClean === true,
                ),
            );
            if (!rebased) return problem(c, 404, 'Fant ikke');
            return c.json({
              draft: await draftView(guard.tenant, service, rebased.entry),
              conflicts: rebased.conflicts,
              applied: rebased.applied,
            });
          } catch (error) {
            return draftFailed(c, error);
          }
        });

        app.delete('/tenants/:tenant/services/:id/draft', async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          const reason = reasonOf(c);
          try {
            const removed = await inTask(
              c,
              guard,
              'platform.service.draft.delete',
              param(c, 'id'),
              reason,
              () =>
                evals.deleteDraft(
                  guard.principal,
                  guard.tenant,
                  param(c, 'id'),
                  reason,
                  typeof data.revision === 'number' ? data.revision : undefined,
                ),
            );
            if (!removed) return problem(c, 404, 'Fant ikke');
            return c.json({ revision: removed.version, deleted: true });
          } catch (error) {
            return draftFailed(c, error);
          }
        });

        app.get('/tenants/:tenant/services/:id/test-sets', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const sets = await deps.evalStores.testSets.list(guard.tenant, param(c, 'id'));
          return c.json({ data: sets.map(setSummary) });
        });

        app.get('/tenants/:tenant/test-sets/:setId/cases', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const set = await deps.evalStores.testSets.get(guard.tenant, param(c, 'setId'));
          if (!set) return problem(c, 404, 'Fant ikke');
          return c.json({ data: set.spec.cases.map(caseView) });
        });

        app.post('/tenants/:tenant/test-sets/:setId/cases', async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const setId = param(c, 'setId');
          const set = await deps.evalStores.testSets.get(guard.tenant, setId);
          if (!set) return problem(c, 404, 'Fant ikke');
          const data = await body(c);
          const input = text(data.input);
          const expected = text(data.expected);
          const type = data.type ?? 'criteria';
          const errors = [
            ...(input ? [] : [{ path: 'input', message: 'the input is required' }]),
            ...(isCaseType(type)
              ? []
              : [{ path: 'type', message: 'type is criteria, exact or must_reject' }]),
            ...(data.split === undefined || isCaseSplit(data.split)
              ? []
              : [{ path: 'split', message: 'split is locked or open' }]),
            ...(type !== 'must_reject' && !expected
              ? [{ path: 'expected', message: 'the expected answer or criteria are required' }]
              : []),
            ...(data.id === undefined || (typeof data.id === 'string' && slug.test(data.id))
              ? []
              : [{ path: 'id', message: 'lowercase letters, digits and dashes' }]),
          ];
          if (errors.length > 0 || !input || !isCaseType(type))
            return problem(c, 400, 'Ugyldig forespørsel', errors);
          const id = typeof data.id === 'string' ? data.id : `c-${randomBytes(4).toString('hex')}`;
          if (set.spec.cases.some((x) => x.id === id))
            return problem(c, 409, 'Konflikt', [{ path: 'id', message: `case ${id} exists` }]);
          const added = caseFrom({
            id,
            input,
            type,
            ...(expected ? { expected } : {}),
            ...(isCaseSplit(data.split) ? { split: data.split } : {}),
          });
          const result = await mountDeps.admin.perform(guard.principal, 'platform.testset.save', {
            tenant: guard.tenant,
            reason: reasonOf(c),
            op: 'put-case',
            id: setId,
            caseId: id,
            body: added,
          });
          c.header('genai-task', result.task);
          if (!result.ok)
            return result.errors.some((e) => e.path === 'principal')
              ? problem(c, 403, 'Ikke tillatt', result.errors)
              : problem(c, 400, 'Ugyldig forespørsel', result.errors);
          return c.json(caseView(testCase.parse(added)), 201);
        });

        app.post('/tenants/:tenant/services/:id/eval-runs', async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const { tenant, principal } = guard;
          const service = param(c, 'id');
          const data = await body(c);
          const setId = text(data.testSet);
          if (!setId)
            return problem(c, 400, 'Ugyldig forespørsel', [
              { path: 'testSet', message: 'the test set is required' },
            ]);
          if (data.split !== undefined && !isCaseSplit(data.split))
            return problem(c, 400, 'Ugyldig forespørsel', [
              { path: 'split', message: 'split is locked or open' },
            ]);
          const only =
            Array.isArray(data.cases) &&
            data.cases.length > 0 &&
            data.cases.every((id) => typeof id === 'string')
              ? (data.cases as string[])
              : undefined;
          if (data.cases !== undefined && !only)
            return problem(c, 400, 'Ugyldig forespørsel', [
              { path: 'cases', message: 'cases is a non-empty list of case ids' },
            ]);
          if (data.trace !== undefined && typeof data.trace !== 'boolean')
            return problem(c, 400, 'Ugyldig forespørsel', [
              { path: 'trace', message: 'trace is true or false' },
            ]);
          const set = await deps.evalStores.testSets.get(tenant, setId);
          if (!set || (set.spec.service !== undefined && set.spec.service !== service))
            return problem(c, 404, 'Fant ikke testsettet', [
              { path: 'testSet', message: `no test set ${setId} for ${service}` },
            ]);
          const unknown = (only ?? []).filter((id) => !set.spec.cases.some((x) => x.id === id));
          if (unknown.length > 0)
            return problem(
              c,
              400,
              'Ugyldig forespørsel',
              unknown.map((id) => ({ path: 'cases', message: `no case ${id} in ${setId}` })),
            );
          const found = await evals.subjectOf(tenant, service, data.version, data);
          if (!found)
            return problem(
              c,
              404,
              data.version === 'draft'
                ? 'Tjenesten har ikke noe lagret utkast'
                : 'Fant ikke versjonen',
              [{ path: 'version', message: `no ${String(data.version ?? 'published')} version` }],
            );
          const variant = text(data.variant);
          if (variant && !variantIdsOf(found.definition).includes(variant))
            return problem(c, 404, 'Fant ikke varianten', [
              { path: 'variant', message: `no variant ${variant}` },
            ]);
          const subject = variant ? { ...found, variant } : found;
          const split = isCaseSplit(data.split) ? data.split : undefined;
          const cases = set.spec.cases.filter(
            (x) => (!split || caseView(x).split === split) && (!only || only.includes(x.id)),
          );
          if (cases.length === 0)
            return problem(c, 409, 'Testsettet har ingen testtilfeller', [
              { path: 'testSet', message: 'no cases to run' },
            ]);
          const started = await evals.startRun(principal, tenant, service, set, subject, {
            ...(split ? { split } : {}),
            ...(only ? { only } : {}),
            ...(data.trace === false ? { trace: false } : {}),
          });
          background(started.done);
          return c.json({ id: started.run.id }, 202);
        });

        app.get('/tenants/:tenant/services/:id/eval-runs', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const runs = await evals.runsOf(guard.tenant, param(c, 'id'));
          return c.json({ data: runs.map(runSummary) });
        });

        app.get('/tenants/:tenant/eval-runs/:runId', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const id = param(c, 'runId');
          const run = await evals.runOf(guard.tenant, id);
          if (run) return c.json({ kind: 'service' as const, ...runView(run) });
          const stored = await deps.evalStores.runs.get(id);
          if (stored?.tenant !== guard.tenant) return problem(c, 404, 'Fant ikke');
          return c.json({
            kind: 'kernel' as const,
            run: stored.run,
            provenance: stored.run.provenance,
            metrics: stored.run.metrics,
            byTag: stored.run.byTag,
          });
        });

        app.post('/tenants/:tenant/services/:id/improvements', async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          const started = await improving.start(
            guard.principal,
            guard.tenant,
            param(c, 'id'),
            text(data.testSet),
            text(data.language),
          );
          if (!started.ok)
            return problem(c, started.status, started.title, [
              { path: started.path, message: started.title },
            ]);
          background(started.done);
          return c.json({ id: started.improvement.id }, 202);
        });

        app.get('/tenants/:tenant/services/:id/improvements', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const data = await improving.list(guard.tenant, param(c, 'id'));
          return c.json({ data: data.map(improvementView) });
        });

        app.post('/tenants/:tenant/services/:id/improvements/:pid/decision', async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          if (typeof data.approve !== 'boolean')
            return problem(c, 400, 'Ugyldig forespørsel', [
              { path: 'approve', message: 'approve is true or false' },
            ]);
          const found = await improving.current(guard.tenant, param(c, 'pid'));
          if (!found || found.spec.service !== param(c, 'id')) return problem(c, 404, 'Fant ikke');
          const result = await mountDeps.admin.perform(
            guard.principal as Principal,
            'platform.improvement.decide',
            {
              tenant: guard.tenant,
              reason: reasonOf(c),
              id: found.spec.id,
              approve: data.approve,
            },
          );
          c.header('genai-task', result.task);
          if (result.ok) return c.json(result.value as object);
          const paths = new Set(result.errors.map((e) => e.path));
          if (paths.has('principal')) return problem(c, 403, 'Ikke tillatt', result.errors);
          if (paths.has('status') || paths.has('draft'))
            return problem(c, 409, 'Konflikt', result.errors);
          if (paths.has('right')) return problem(c, 403, 'Ikke tillatt', result.errors);
          return problem(c, 400, 'Ugyldig forespørsel', result.errors);
        });
      },
    };
  };

export const qualityModule: PlatformModuleFactory = createQualityModule();
