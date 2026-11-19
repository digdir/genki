import {
  flowUsesOf,
  isInternalService,
  type DefinitionStore,
  type FlowStep,
  type ServiceDefinition,
  type StepFlowDefinition,
} from '@genai/definitions';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { appendVersion, serialized, type ConfigEntryStore } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import { hidesInternalServices, seeingInternalServices } from './internal-services.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { lifecycleOf } from './service-lifecycle.js';

export const stepFlowArchiveKind = 'step-flow-archive';
export const stepFlowArchiveAction = 'platform.step-flow.archive';
export const stepFlowInUseType = 'urn:genai:problem:step-flow-in-use';

interface ArchiveSpec {
  version: number;
}

export const isFlowArchived = async (
  entries: ConfigEntryStore,
  tenant: string,
  id: string,
  latestVersion: number,
) => {
  const latest = (await entries.history(stepFlowArchiveKind, tenant, id)).at(-1);
  if (!latest || latest.deleted) return false;
  return (latest.spec as ArchiveSpec).version >= latestVersion;
};

export interface FlowUser {
  tenant: string;
  service: string;
  internal: boolean;
}

const subflowsOf = (steps: readonly FlowStep[]): string[] =>
  steps.flatMap((s) => [
    ...(s.subflow ? [s.subflow] : []),
    ...subflowsOf(s.repeat?.steps ?? []),
    ...subflowsOf(s.forEach?.steps ?? []),
    ...(s.cases ?? []).flatMap((c) => subflowsOf(c.steps)),
    ...subflowsOf(s.else ?? []),
  ]);

const split = (ref: string) => {
  const at = ref.lastIndexOf('@');
  return { id: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
};

/** Every published, not archived service in any tenant that runs the flow, directly or as a subflow. */
export const flowUsers = (
  deps: {
    definitions: Pick<DefinitionStore, 'list' | 'get' | 'capabilities'>;
    configEntries: ConfigEntryStore;
    platformTenant: string;
  },
  owner: string,
  flow: string,
): Promise<FlowUser[]> =>
  seeingInternalServices(async () => {
    const { definitions } = deps;
    const tenants =
      owner === deps.platformTenant
        ? new Set([owner, ...(await definitions.capabilities()).map((c) => c.service.tenant)])
        : new Set([owner]);
    const users: FlowUser[] = [];
    for (const tenant of tenants) {
      const entries = await definitions.list(tenant);
      const own = new Set(entries.filter((e) => e.kind === 'StepFlow').map((e) => e.id));
      const ownerOf = (id: string) => (own.has(id) ? tenant : deps.platformTenant);
      const reaches = async (refs: string[]) => {
        const seen = new Set<string>();
        const queue = [...refs];
        while (queue.length > 0) {
          const ref = queue.shift() as string;
          if (seen.has(ref)) continue;
          seen.add(ref);
          const { id, version } = split(ref);
          const from = ownerOf(id);
          if (from === owner && id === flow) return true;
          const found = await definitions.get('StepFlow', from, id, version);
          const steps = (found?.definition as StepFlowDefinition | undefined)?.spec.steps ?? [];
          queue.push(...subflowsOf(steps));
        }
        return false;
      };
      for (const entry of entries) {
        if (entry.kind !== 'Service') continue;
        const latest = await definitions.get('Service', tenant, entry.id);
        if (!latest) continue;
        const definition = latest.definition as ServiceDefinition;
        if ((await lifecycleOf(deps.configEntries, tenant, entry.id)).state === 'archived')
          continue;
        if (await reaches(flowUsesOf(definition.spec).map((u) => u.flow)))
          users.push({ tenant, service: entry.id, internal: isInternalService(definition) });
      }
    }
    return users;
  });

const problem = (
  c: Context,
  status: 400 | 401 | 404 | 409,
  title: string,
  errors: { path: string; message: string }[] = [],
  extra: Record<string, unknown> = {},
  type = 'about:blank',
) =>
  c.json({ type, title, status, errors, ...extra }, status, {
    'content-type': 'application/problem+json',
  });

export const stepFlowArchiveModule: PlatformModuleFactory = (deps) => {
  const writes = serialized();
  return {
    id: 'step-flow-archive',
    handlers: routeOnlyActions([stepFlowArchiveAction]),
    mount: (app, mounted) => {
      app.delete('/tenants/:tenant/step-flows/:id', async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Unauthorized');
        const tenant = c.req.param('tenant') ?? '';
        const id = c.req.param('id') ?? '';
        const entered = enterTenant(c, mounted.access, principal, tenant, 'manage-services');
        if ('response' in entered) return entered.response;
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const hides = hidesInternalServices();
        return writes(async () => {
          const latest = (await deps.definitions.versions('StepFlow', tenant, id)).at(-1);
          if (!latest || (await isFlowArchived(deps.configEntries, tenant, id, latest.version)))
            return problem(c, 404, 'Not found', [
              { path: 'id', message: t('problems.stepFlowNotFound', { id }) },
            ]);
          const users = await flowUsers(deps, tenant, id);
          if (users.length > 0) {
            const visible = users.filter((u) => !(hides && u.internal));
            const shown = visible.filter((u) => u.tenant === tenant);
            const hidden = users.length - visible.length;
            const elsewhere = visible.length - shown.length;
            return problem(
              c,
              409,
              t('problems.stepFlowInUseTitle'),
              [
                ...shown.map((u) => ({
                  path: 'usedBy',
                  message: t('problems.stepFlowUsedBy', { tenant: u.tenant, service: u.service }),
                })),
                ...(elsewhere > 0
                  ? [
                      {
                        path: 'usedBy',
                        message: t('problems.stepFlowUsedByOthers', { count: elsewhere }),
                      },
                    ]
                  : []),
                ...(hidden > 0
                  ? [
                      {
                        path: 'usedBy',
                        message: t('problems.stepFlowUsedByInternal', { count: hidden }),
                      },
                    ]
                  : []),
              ],
              {
                usedBy: shown.map((u) => ({ tenant: u.tenant, service: u.service })),
                ...(elsewhere > 0 ? { otherOrganisations: elsewhere } : {}),
                ...(hidden > 0 ? { internalServices: hidden } : {}),
              },
              stepFlowInUseType,
            );
          }
          try {
            const done = await mounted.admin.within(
              entered.principal,
              stepFlowArchiveAction,
              { tenant, id, reason, version: latest.version },
              async () => {
                await appendVersion<ArchiveSpec>(deps.configEntries, {
                  kind: stepFlowArchiveKind,
                  scope: tenant,
                  id,
                  spec: { version: latest.version },
                  deleted: false,
                  by: actorOf(entered.principal.actor ?? entered.principal),
                  reason,
                });
                return {
                  value: { id, archived: true, version: latest.version },
                  target: `step-flow:${id}`,
                  audit: { version: latest.version },
                };
              },
            );
            c.header('genai-task', done.task);
            return c.json(done.value);
          } catch (error) {
            if (error instanceof AdminRefused) {
              c.header('genai-task', error.task);
              return refusedBy(c, error);
            }
            throw error;
          }
        });
      });
    },
  };
};
