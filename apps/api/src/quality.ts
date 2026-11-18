import { randomBytes } from 'node:crypto';
import { draftServiceOf, originOf, trialOrigins } from './draft-runner.js';
import { isInternalService } from '@genai/definitions';
import type { Principal } from '@genai/contracts';
import {
  caseExpectation,
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
import { actorNames } from './actor-names.js';
import { actorOf, AdminRefused, refusedBy, routeOnly } from './admin.js';
import type { LeaseOptions } from './background-lease.js';
import { VersionConflict, type ConfigEntry } from './config-store.js';
import { changeReasonOf } from './http.js';
import { improvements, improvementView } from './improvements.js';
import { t } from './i18n/index.js';
import { hidesInternalServices, isHiddenService } from './internal-services.js';
import { candidatesIn, withCandidateTrial } from './model-access.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { rightsOf, seesUsage, type Right } from './rights.js';
import { connectionsCovering } from './trace-connections.js';
import { datasetsOf } from './trace-datasets.js';
import { compareCases, isCaseChange, runSide } from './eval-compare.js';
import {
  runDetail,
  casesIn,
  runSummary,
  RunRefused,
  serviceEval,
  shownRun,
  TraceRefused,
  type ServiceDraft,
} from './service-eval.js';

type Status = 400 | 401 | 403 | 404 | 409 | 422;

const compareInvalid = 'urn:genai:problem:eval-compare-invalid';
const notComparable = 'urn:genai:problem:eval-runs-not-comparable';

const problem = (
  c: Context,
  status: Status,
  title: string,
  errors: unknown[] = [],
  type = 'about:blank',
) =>
  c.json({ type, title, status, errors }, status, {
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

const costless = <
  T extends { cost?: unknown; tokens?: unknown; usdNok?: unknown; sinkJudges?: object[] },
>(
  view: T,
) => {
  const shown: Partial<T> = { ...view };
  delete shown.cost;
  delete shown.tokens;
  delete shown.usdNok;
  delete (shown as { sinkOthers?: unknown }).sinkOthers;
  // What a sink reports its judges' calls cost is usage too.
  if (view.sinkJudges)
    shown.sinkJudges = view.sinkJudges.map((j) => {
      const rest = { ...(j as { reported?: unknown }) };
      delete rest.reported;
      return rest;
    }) as T['sinkJudges'];
  return shown;
};

export const serviceDraftActions = [
  'platform.service.draft.save',
  'platform.service.draft.rebase',
  'platform.service.draft.delete',
] as const;

export const createQualityModule =
  (
    options: {
      onBackground?: (work: Promise<void>) => void;
      leases?: LeaseOptions;
      resumeEveryMs?: number;
    } = {},
  ): PlatformModuleFactory =>
  (deps) => {
    const background = (work: Promise<void>) => {
      work.catch(() => undefined);
      options.onBackground?.(work);
    };
    const evals = serviceEval(deps, options.leases, background);
    const isSinkJudge = (evaluator: string) => deps.traceSinks?.isSinkJudge?.(evaluator) ?? false;
    const improving = improvements(deps, evals);
    background(improving.recover());
    background(evals.resumeAbandoned());
    const sweep = setInterval(
      () => background(evals.resumeAbandoned()),
      options.resumeEveryMs ?? 30_000,
    );
    sweep.unref?.();

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
          return {
            principal: entered.principal,
            tenant,
            operator: principal.kind === 'operator',
          };
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
          by: draft.by,
          byName: (await actorNames(deps.configEntries).nameOf(draft.by)) ?? null,
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

        const trialRunsByService = async (tenant: string) => {
          const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
          const capabilities = deps.tasks.envelopes
            ? (await deps.tasks.envelopes(tenant, { since, limit: 50_000 })).map(
                (t) => t.service.capability.id,
              )
            : (
                await Promise.all(
                  (await deps.tasks.all(tenant))
                    .filter((t) => t.at >= since)
                    .map(async (t) => (await deps.task(t.task))?.service.capability.id),
                )
              ).filter((id): id is string => id !== undefined);
          const counts = new Map<string, number>();
          for (const id of capabilities) {
            if (!trialOrigins.includes(originOf(id))) continue;
            const service = draftServiceOf(id);
            if (service) counts.set(service, (counts.get(service) ?? 0) + 1);
          }
          return counts;
        };

        app.get('/tenants/:tenant/service-drafts', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const drafts = await evals.drafts.list(guard.tenant);
          const hidden = await Promise.all(
            drafts.map((d) => isHiddenService(deps.definitions, guard.tenant, d.id)),
          );
          const found = drafts.filter((_, i) => !hidden[i]);
          const people = await actorNames(deps.configEntries).namesOf(found.map((d) => d.by));
          const trials = await trialRunsByService(guard.tenant);
          const data = await Promise.all(
            found.map(async (draft) => {
              const { metadata, spec } = draft.spec.definition;
              const output = isRecord(spec) ? spec.output : undefined;
              const byName = people.get(draft.by);
              return {
                id: draft.id,
                name: (isRecord(metadata) && text(metadata.name)) || null,
                purpose: (isRecord(spec) && text(spec.purpose)) || '',
                outputKind: (isRecord(output) && text(output.kind)) || 'answer',
                latestVersion: (await evals.drafts.latestVersion(guard.tenant, draft.id)) ?? null,
                revision: draft.version,
                at: draft.at,
                by: draft.by,
                ...(byName ? { byName } : {}),
                trialRuns7d: trials.get(draft.id) ?? 0,
              };
            }),
          );
          return c.json({ data });
        });

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

        app.get('/tenants/:tenant/services/:id/draft/checks', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const service = param(c, 'id');
          const draft = await evals.draftOf(guard.tenant, service);
          if (!draft) return problem(c, 404, t('problems.draftNotFound'));
          if (!deps.publishCheck) return problem(c, 404, t('problems.draftNotFound'));
          const definition = draft.spec.definition;
          const metadata =
            isRecord(definition) && isRecord(definition.metadata) ? definition.metadata : {};
          const problems =
            metadata.tenant !== guard.tenant || metadata.id !== service
              ? [{ path: 'metadata', message: t('problems.draftOtherService') }]
              : await deps.publishCheck(
                  definition,
                  actorOf(guard.principal.actor ?? guard.principal),
                );
          const hooks = deps.hookRuntime
            ? await deps.hookRuntime.directory.forTenant(guard.tenant)
            : [];
          const hooksSkipped = hooks.some((h) => h.point === 'on_publish' && h.enabled);
          return c.json({
            service,
            revision: draft.version,
            ready: problems.length === 0,
            problems,
            ...(hooksSkipped ? { hooksSkipped: true } : {}),
          });
        });

        app.put('/tenants/:tenant/services/:id/draft', async (c) => {
          const guard = await member(c, 'manage-services');
          if (guard.response) return guard.response;
          const data = await body(c);
          if (!isRecord(data.definition))
            return problem(c, 400, 'Ugyldig forespørsel', [
              { path: 'definition', message: 'a definition is required' },
            ]);
          if (
            hidesInternalServices() &&
            isInternalService(data.definition) &&
            !isInternalService((await evals.draftOf(guard.tenant, param(c, 'id')))?.spec.definition)
          )
            return problem(c, 422, 'Ugyldig forespørsel', [
              { path: 'definition.spec.visibility', message: t('problems.internalOperatorOnly') },
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
          const service = param(c, 'id');
          const sets = await deps.evalStores.testSets.list(guard.tenant, service);
          // The Langfuse dataset an agency points its judges at, in the covering connection.
          const covering = await connectionsCovering(deps.configEntries, guard.tenant, service);
          const made = (
            await datasetsOf(deps.configEntries, deps.evalStores.testSets, guard.tenant)
          ).filter(
            (d) =>
              covering.length === 1 && d.connection === covering[0]?.id && d.service === service,
          );
          return c.json({
            data: sets.map((set) => {
              const dataset = made.find((d) => d.testSet === set.metadata.id);
              return {
                ...setSummary(set),
                ...(dataset
                  ? { dataset: { connection: dataset.connection, name: dataset.name } }
                  : {}),
              };
            }),
          });
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
          const structured = isRecord(data.expected)
            ? caseExpectation.safeParse(data.expected)
            : undefined;
          const expected = structured ? structured.data : text(data.expected);
          const described =
            typeof expected === 'string' ||
            expected?.referenceAnswer !== undefined ||
            Object.keys(expected?.criteria ?? {}).length > 0;
          const type = data.type ?? 'criteria';
          const errors = [
            ...(input ? [] : [{ path: 'input', message: 'the input is required' }]),
            ...(isCaseType(type)
              ? []
              : [{ path: 'type', message: 'type is criteria, exact or must_reject' }]),
            ...(data.split === undefined || isCaseSplit(data.split)
              ? []
              : [{ path: 'split', message: 'split is locked or open' }]),
            ...(structured && !structured.success
              ? [
                  {
                    path: 'expected',
                    message: 'expected is a text, or a reference answer and named criteria',
                  },
                ]
              : type !== 'must_reject' && !described
                ? [{ path: 'expected', message: 'the expected answer or criteria are required' }]
                : // Given as fields, a case needs the one its type is judged on.
                  structured?.success && type === 'criteria' && !structured.data.criteria
                  ? [{ path: 'expected.criteria', message: 'a criteria case needs criteria' }]
                  : structured?.success && type === 'exact' && !structured.data.referenceAnswer
                    ? [
                        {
                          path: 'expected.referenceAnswer',
                          message: 'an exact case needs the text to find',
                        },
                      ]
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
            ...(expected && described ? { expected } : {}),
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
          const trial =
            guard.operator &&
            subject.version === 'draft' &&
            candidatesIn(deps.catalog, subject.definition).length > 0;
          const split = isCaseSplit(data.split) ? data.split : undefined;
          if (casesIn(set, split, only).length === 0)
            return problem(c, 409, 'Testsettet har ingen testtilfeller', [
              { path: 'testSet', message: 'no cases to run' },
            ]);
          try {
            const started = await evals.startRun(
              trial ? withCandidateTrial(principal) : principal,
              tenant,
              service,
              set,
              subject,
              split,
              only,
              { trace: data.trace === true },
            );
            background(started.done);
            return c.json({ id: started.run.id }, 202);
          } catch (error) {
            if (error instanceof RunRefused)
              return problem(c, 422, 'Tjenesten kan ikke kjøres', error.errors);
            if (!(error instanceof TraceRefused)) throw error;
            return problem(
              c,
              409,
              'Testkjøringen kan ikke sendes til sporing',
              error.messages.map((message) => ({ path: 'trace', message })),
            );
          }
        });

        app.get('/tenants/:tenant/services/:id/eval-runs/sending', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const service = param(c, 'id');
          const version = c.req.query('version');
          const found = await evals.subjectOf(
            guard.tenant,
            service,
            version === 'draft' ? 'draft' : version ? Number(version) : undefined,
          );
          if (!found)
            return problem(c, 404, 'Fant ikke', [
              { path: 'version', message: `no ${version ?? 'published'} version` },
            ]);
          // The judges that reach a run depend on its test set, by its dataset and its name.
          const testSet = c.req.query('testSet');
          const set = testSet
            ? (await deps.evalStores.testSets.list(guard.tenant, service)).find(
                (s) => s.metadata.id === testSet,
              )
            : undefined;
          if (!set)
            return problem(c, 404, 'Fant ikke', [
              { path: 'testSet', message: `no test set ${testSet ?? ''} in the service` },
            ]);
          return c.json(await evals.sendingOf(guard.tenant, service, found, set));
        });

        app.get('/tenants/:tenant/services/:id/eval-runs', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const runs = await evals.runsOf(guard.tenant, param(c, 'id'));
          const usage = seesUsage(guard.principal, guard.tenant);
          const agreementsOf = await deps.sinkLabels?.agreementsFor(guard.tenant);
          return c.json({
            data: runs.map((s) => {
              const summary = runSummary(s.run, isSinkJudge, agreementsOf?.(s.run));
              return usage ? summary : costless(summary);
            }),
          });
        });

        app.get('/tenants/:tenant/services/:id/eval-runs/compare', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const { tenant } = guard;
          const service = param(c, 'id');
          const invalid = (path: string, message: string) =>
            problem(c, 400, t('problems.evalCompareInvalid'), [{ path, message }], compareInvalid);
          const candidateId = text(c.req.query('candidate'));
          if (!candidateId) return invalid('candidate', 'the candidate run is required');
          const change = c.req.query('change');
          if (change !== undefined && !isCaseChange(change))
            return invalid('change', 'change is worse, better, new, missing, pending or same');
          const limit = Number(c.req.query('limit') ?? 50);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            return invalid('limit', 'limit is 1 to 200');
          const offset = Number(c.req.query('offset') ?? 0);
          if (!Number.isInteger(offset) || offset < 0 || offset > 100_000)
            return invalid('offset', 'offset is 0 to 100000');
          if (await isHiddenService(deps.definitions, tenant, service))
            return problem(c, 404, t('problems.evalRunNotFound'));
          const ofService = async (id: string) => {
            const stored = await evals.runOf(tenant, id);
            return stored?.service === service && stored.run.tested ? stored : undefined;
          };
          const candidate = await ofService(candidateId);
          if (!candidate)
            return problem(c, 404, t('problems.evalRunNotFound'), [
              { path: 'candidate', message: `no run ${candidateId} of ${service}` },
            ]);
          const baselineId = text(c.req.query('baseline')) ?? 'published';
          const baseline =
            baselineId === 'published'
              ? await evals.publishedBaseline(
                  tenant,
                  service,
                  candidate.run.testSet.id,
                  candidate.run.id,
                )
              : await ofService(baselineId);
          if (!baseline)
            return baselineId === 'published'
              ? problem(c, 404, t('problems.evalBaselineMissing'), [
                  { path: 'baseline', message: 'no completed run of the published version' },
                ])
              : problem(c, 404, t('problems.evalRunNotFound'), [
                  { path: 'baseline', message: `no run ${baselineId} of ${service}` },
                ]);
          if (baseline.run.testSet.id !== candidate.run.testSet.id)
            return problem(
              c,
              400,
              t('problems.evalRunsNotComparable'),
              [{ path: 'baseline', message: 'the runs are of different test sets' }],
              notComparable,
            );
          const setOf = (run: typeof candidate.run) =>
            deps.evalStores.testSets.get(tenant, run.testSet.id, run.testSet.version);
          const compared = compareCases(
            { run: baseline.run, set: await setOf(baseline.run) },
            { run: candidate.run, set: await setOf(candidate.run) },
          );
          const matching = change
            ? compared.cases.filter((x) => x.change === change)
            : compared.cases;
          return c.json({
            testSet: candidate.run.testSet.id,
            baseline: { ...runSide(baseline.run), published: baselineId === 'published' },
            candidate: runSide(candidate.run),
            counts: compared.counts,
            data: matching.slice(offset, offset + limit),
            total: matching.length,
            offset,
            limit,
          });
        });

        app.get('/tenants/:tenant/eval-runs/:runId', async (c) => {
          const guard = await member(c);
          if (guard.response) return guard.response;
          const stored = await evals.runOf(guard.tenant, param(c, 'runId'));
          if (
            !stored ||
            (stored.service !== undefined &&
              (await isHiddenService(deps.definitions, guard.tenant, stored.service)))
          )
            return problem(c, 404, 'Fant ikke');
          if (stored.run.tested) {
            const set = await deps.evalStores.testSets.get(
              guard.tenant,
              stored.run.testSet.id,
              stored.run.testSet.version,
            );
            const detail = runDetail(stored.run, set, await evals.answersOf(stored.run), {
              isSinkJudge,
              reasons: await evals.judgeReasonsOf(stored.run, isSinkJudge),
              ...(deps.sinkLabels
                ? { agreements: await deps.sinkLabels.agreements(guard.tenant, stored.run) }
                : {}),
            });
            const shown = seesUsage(guard.principal, guard.tenant) ? detail : costless(detail);
            return c.json({ kind: 'service' as const, ...shown });
          }
          return c.json({
            kind: 'kernel' as const,
            run: shownRun(stored.run, seesUsage(guard.principal, guard.tenant)),
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
