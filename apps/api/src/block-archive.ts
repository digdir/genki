import { blockZones } from '@genai/contracts';
import {
  isInternalService,
  parseBlockRef,
  type DefinitionStore,
  type ServiceDefinition,
} from '@genai/definitions';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { appendVersion, serialized, type ConfigEntryStore } from './config-store.js';
import { requireFlag } from './feature-flags.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import { hidesInternalServices, seeingInternalServices } from './internal-services.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { serviceDrafts } from './service-drafts.js';
import { environmentsOf } from './service-environments.js';
import { lifecycleOf } from './service-lifecycle.js';

export const blockArchiveKind = 'block-archive';
export const blockArchiveAction = 'platform.block.archive';
export const blockInUseType = 'urn:genai:problem:block-in-use';

interface ArchiveSpec {
  version: number;
}

/** Archived until an edition newer than the archived one is published. */
export const isBlockArchived = async (
  entries: Pick<ConfigEntryStore, 'history'>,
  publisher: string,
  id: string,
  latestVersion: number,
) => {
  const latest = (await entries.history(blockArchiveKind, publisher, id)).at(-1);
  if (!latest || latest.deleted) return false;
  return (latest.spec as ArchiveSpec).version >= latestVersion;
};

export interface BlockUser {
  tenant: string;
  service: string;
  name: string;
  internal: boolean;
}

type Tree = Record<string, unknown>;

const isRecord = (value: unknown): value is Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pins = (definition: unknown, publisher: string, id: string) => {
  const spec = isRecord(definition) && isRecord(definition.spec) ? definition.spec : undefined;
  const shown = spec && isRecord(spec.interface) ? spec.interface : undefined;
  const layout = shown && isRecord(shown.layout) ? shown.layout : undefined;
  const zones = layout && isRecord(layout.zones) ? layout.zones : {};
  return blockZones.some((zone) => {
    const placed = zones[zone];
    return (
      Array.isArray(placed) &&
      placed.some((p) => {
        const target = isRecord(p) && typeof p.ref === 'string' ? parseBlockRef(p.ref) : undefined;
        return target?.publisher === publisher && target.id === id;
      })
    );
  });
};

/** Every not archived service whose draft, latest or environment-pinned version pins the block. */
export const blockUsers = (
  deps: {
    definitions: Pick<DefinitionStore, 'list' | 'get' | 'listAcross'>;
    configEntries: ConfigEntryStore;
  },
  publisher: string,
  id: string,
): Promise<BlockUser[]> =>
  seeingInternalServices(async () => {
    const { definitions, configEntries } = deps;
    const drafts = serviceDrafts(configEntries, definitions);
    const services = definitions.listAcross
      ? await definitions.listAcross('Service')
      : (await definitions.list(publisher))
          .filter((e) => e.kind === 'Service')
          .map((e) => ({ tenant: publisher, id: e.id }));
    const users: BlockUser[] = [];
    for (const { tenant, id: service } of services) {
      const latest = await definitions.get('Service', tenant, service);
      if (!latest) continue;
      if ((await lifecycleOf(configEntries, tenant, service)).state === 'archived') continue;
      const draft = await drafts.draftOf(tenant, service);
      const pinned = Object.values(await environmentsOf(configEntries, tenant, service)).flatMap(
        (p) => (p.version !== undefined && p.version !== latest.version ? [p.version] : []),
      );
      const versions = [latest.definition, draft?.spec.definition];
      for (const version of new Set(pinned))
        versions.push((await definitions.get('Service', tenant, service, version))?.definition);
      if (versions.some((d) => pins(d, publisher, id)))
        users.push({
          tenant,
          service,
          name: (latest.definition as ServiceDefinition).metadata.name ?? service,
          internal: isInternalService(latest.definition as ServiceDefinition),
        });
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

export const blockArchiveModule: PlatformModuleFactory = (deps) => {
  const writes = serialized();
  return {
    id: 'block-archive',
    handlers: routeOnlyActions([blockArchiveAction]),
    mount: (app, mounted) => {
      app.delete('/tenants/:tenant/blocks/:id', requireFlag(mounted, 'blockStudio'), async (c) => {
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
          const latest = (await deps.definitions.versions('Block', tenant, id)).at(-1);
          const builtIn =
            (latest?.definition as { spec?: { tier?: string } } | undefined)?.spec?.tier ===
            'built-in';
          if (
            !latest ||
            builtIn ||
            (await isBlockArchived(deps.configEntries, tenant, id, latest.version))
          )
            return problem(c, 404, t('problems.blockNotFound'));
          const users = await blockUsers(deps, tenant, id);
          if (users.length > 0) {
            const shown = users.filter((u) => u.tenant === tenant && !(hides && u.internal));
            const elsewhere = users.length - shown.length;
            return problem(
              c,
              409,
              t('problems.blockInUseTitle'),
              [
                ...shown.map((u) => ({
                  path: 'usedBy',
                  message: t('problems.blockUsedBy', { service: u.name }),
                })),
                ...(elsewhere > 0
                  ? [
                      {
                        path: 'usedBy',
                        message: t('problems.blockUsedByOthers', { count: elsewhere }),
                      },
                    ]
                  : []),
              ],
              {
                usedBy: shown.map((u) => ({ tenant: u.tenant, service: u.service })),
                ...(elsewhere > 0 ? { otherServices: elsewhere } : {}),
              },
              blockInUseType,
            );
          }
          try {
            const done = await mounted.admin.within(
              entered.principal,
              blockArchiveAction,
              { tenant, id, reason, version: latest.version },
              async () => {
                await appendVersion<ArchiveSpec>(deps.configEntries, {
                  kind: blockArchiveKind,
                  scope: tenant,
                  id,
                  spec: { version: latest.version },
                  deleted: false,
                  by: actorOf(entered.principal.actor ?? entered.principal),
                  reason,
                });
                return {
                  value: { id, archived: true, version: latest.version },
                  target: `block:${id}`,
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
