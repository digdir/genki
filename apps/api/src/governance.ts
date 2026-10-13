import type { Principal } from '@genai/contracts';
import type { Definition, ServiceDefinition, ValidationError } from '@genai/definitions';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { appendVersion, type ConfigEntry } from './config-store.js';
import type { ModuleDeps, MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { changeReasonOf } from './http.js';

export const riskConfirmationKind = 'risk-confirmation';

type RiskClass = ServiceDefinition['spec']['riskClass'];

export interface RiskConfirmationRecord {
  riskClass: RiskClass;
  reasons: string[];
}

const confirmedClasses: readonly RiskClass[] = ['limited', 'high'];

const isService = (definition: unknown): definition is ServiceDefinition =>
  typeof definition === 'object' &&
  definition !== null &&
  (definition as { kind?: unknown }).kind === 'Service';

export const needsRiskConfirmation = (definition: unknown): definition is ServiceDefinition =>
  isService(definition) && confirmedClasses.includes(definition.spec.riskClass);

export const riskConfirmationProblems = (definition: Definition): ValidationError[] => {
  if (!needsRiskConfirmation(definition)) return [];
  const { riskClass, riskConfirmation } = definition.spec;
  if (!riskConfirmation)
    return [
      {
        path: 'spec.riskConfirmation',
        message: `risk class ${riskClass} must be confirmed by a person with the publish right before publishing`,
      },
    ];
  if (riskConfirmation.riskClass !== undefined && riskConfirmation.riskClass !== riskClass)
    return [
      {
        path: 'spec.riskConfirmation',
        message: `the confirmation is for risk class ${riskConfirmation.riskClass}, but the service is ${riskClass}; confirm the risk class again`,
      },
    ];
  return [];
};

export const confirmedBy = (
  definition: Definition,
  principal: Principal,
  now: Date = new Date(),
): Definition => {
  if (!needsRiskConfirmation(definition) || !definition.spec.riskConfirmation) return definition;
  return {
    ...definition,
    spec: {
      ...definition.spec,
      riskConfirmation: {
        reasons: definition.spec.riskConfirmation.reasons,
        riskClass: definition.spec.riskClass,
        by: actorOf(principal.actor ?? principal),
        at: now.toISOString(),
      },
    },
  };
};

const twoConfirmers =
  'a high-risk service needs the risk class confirmed by two different people with the publish right; ask a colleague to confirm it before you publish';

export const governanceModule: PlatformModuleFactory = (deps: ModuleDeps) => {
  const confirmations = async (tenant: string, service: string) =>
    (
      (await deps.configEntries.history(
        riskConfirmationKind,
        tenant,
        service,
      )) as ConfigEntry<RiskConfirmationRecord>[]
    ).filter((e) => !e.deleted);

  const checkPublish = async (definition: unknown): Promise<ValidationError[]> => {
    if (!isService(definition) || definition.spec.riskClass !== 'high') return [];
    const problems = riskConfirmationProblems(definition);
    if (problems.length > 0) return problems;
    const { tenant, id } = definition.metadata;
    const since = (await deps.definitions.get('Service', tenant, id))?.publishedAt ?? '';
    const people = new Set([
      definition.spec.riskConfirmation?.by,
      ...(await confirmations(tenant, id))
        .filter((e) => e.spec.riskClass === 'high' && e.at > since)
        .map((e) => e.by),
    ]);
    return people.size >= 2 ? [] : [{ path: 'spec.riskConfirmation', message: twoConfirmers }];
  };

  const mount = <E extends Env, S extends Schema, B extends string>(
    app: Hono<E, S, B>,
    mountDeps: MountDeps,
  ) => {
    const problem = (
      c: Context,
      status: 400 | 401 | 403,
      title: string,
      errors: ValidationError[] = [],
    ) =>
      c.json({ type: 'about:blank', title, status, errors }, status, {
        'content-type': 'application/problem+json',
      });

    const path = '/tenants/:tenant/services/:id/risk-confirmations';

    app.get(path, async (c) => {
      const principal = await mountDeps.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Unauthorized');
      const tenant = c.req.param('tenant') ?? '';
      const entered = enterTenant(c, mountDeps.access, principal, tenant);
      if ('response' in entered) return entered.response;
      const entries = await confirmations(tenant, c.req.param('id') ?? '');
      return c.json({
        data: entries.map((e) => ({ riskClass: e.spec.riskClass, by: e.by, at: e.at })),
      });
    });

    app.post(path, async (c) => {
      const principal = await mountDeps.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Unauthorized');
      const tenant = c.req.param('tenant') ?? '';
      const entered = enterTenant(c, mountDeps.access, principal, tenant, 'manage-services');
      if ('response' in entered) return entered.response;
      const acting = entered.principal;
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const riskClass = confirmedClasses.find((r) => r === body.riskClass);
      if (!riskClass)
        return problem(c, 400, 'Invalid request', [
          { path: 'riskClass', message: 'riskClass is limited or high' },
        ]);
      const reasons = Array.isArray(body.reasons)
        ? body.reasons.filter((r): r is string => typeof r === 'string')
        : [];
      const service = c.req.param('id') ?? '';
      const reason = changeReasonOf(c)?.trim() ?? '';
      const confirmed = await mountDeps.admin
        .within(
          acting,
          'platform.service.risk.confirm',
          { tenant, reason, service, riskClass },
          async () => ({
            value: await appendVersion<RiskConfirmationRecord>(deps.configEntries, {
              kind: riskConfirmationKind,
              scope: tenant,
              id: service,
              spec: { riskClass, reasons },
              deleted: false,
              by: actorOf(acting.actor ?? acting),
              reason,
            }),
            target: `service:${service}/risk`,
            audit: { after: { riskClass } },
          }),
        )
        .catch((error: unknown) => {
          if (error instanceof AdminRefused) return error;
          throw error;
        });
      if (confirmed instanceof AdminRefused) {
        c.header('genai-task', confirmed.task);
        return refusedBy(c, confirmed);
      }
      const { value: saved, task } = confirmed;
      c.header('genai-task', task);
      return c.json({ riskClass, by: saved.by, at: saved.at }, 201);
    });
  };

  return {
    id: 'governance',
    handlers: routeOnlyActions(['platform.service.risk.confirm']),
    mount,
    checkPublish,
  };
};
