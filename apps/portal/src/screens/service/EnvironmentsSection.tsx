import { ApiError, type ApiClient } from '../../api';
import { productionEnvironment, type ServiceEnvironments } from '../../api/environments';
import type { EnvironmentChange } from '../../api/service-tabs';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import type { T } from '../../i18n';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import type { ClientView, ServiceKeyView, VersionSummary } from '../../types';
import type { Format } from '@genai/i18n';
import { placeName, shortWhen } from './dev-format';
import { Environments, type EnvironmentFacts, type HistoryEntry } from './Environments';

const settled = <T,>(r: PromiseSettledResult<T>) =>
  r.status === 'fulfilled' ? r.value : undefined;

const historyLimit = 10;

const changeText = (c: EnvironmentChange, t: T, f: Format, who: string) => {
  const when = shortWhen(c.at, f);
  const base = { when, environment: placeName(t, c.environment), who };
  const moved = { ...base, from: c.previousVersion ?? '', to: c.version ?? '' };
  const text =
    c.action === 'promoted'
      ? t('serviceDev.historyPromoted', moved)
      : c.action === 'rolled-back'
        ? t('serviceDev.historyRolledBack', moved)
        : c.action === 'changed'
          ? t('serviceDev.historyChanged', moved)
          : c.action === 'added'
            ? t('serviceDev.historyAdded', base)
            : c.action === 'described'
              ? t('serviceDev.historyDescribed', base)
              : t('serviceDev.historyRemoved', base);
  return c.reason ? t('serviceDev.withReason', { text, reason: c.reason }) : text;
};

export const environmentHistory = (
  changes: EnvironmentChange[],
  environments: ServiceEnvironments,
  versions: VersionSummary[],
  t: T,
  f: Format,
  who: (actor: string, name?: string) => string,
): HistoryEntry[] => {
  const added = new Map(
    changes.filter((c) => c.action === 'added').map((c) => [c.environment, c.at]),
  );
  const published = environments.environments
    .filter((e) => e.followsPublishes && environments.environments.length > 1)
    .flatMap((e) =>
      versions
        .filter((v) => v.version > 1 && v.publishedAt >= (added.get(e.name) ?? ''))
        .map((v) => ({
          at: v.publishedAt,
          text: t('serviceDev.historyPublished', {
            when: shortWhen(v.publishedAt, f),
            environment: placeName(t, e.name),
            version: v.version,
          }),
        })),
    );
  return [
    ...changes.map((c) => ({ at: c.at, text: changeText(c, t, f, who(c.by, c.byName)) })),
    ...published,
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, historyLimit);
};

const frontendsIn = (environment: string, clients: ClientView[], keys: ServiceKeyView[]) =>
  clients.filter((c) => {
    const bound = keys.filter((k) => k.client === c.definition.metadata.id);
    return bound.length
      ? bound.some((k) => !k.environments?.length || k.environments.includes(environment))
      : environment === productionEnvironment;
  }).length;

const sinceOf = (
  environment: string,
  version: number | null,
  changes: EnvironmentChange[],
  versions: VersionSummary[],
) =>
  changes.find(
    (c) => c.environment === environment && c.version === version && c.action !== 'removed',
  )?.at ?? versions.find((v) => v.version === version)?.publishedAt;

export const EnvironmentsSection = ({
  api,
  tenant,
  serviceId,
  now = () => new Date(),
}: {
  api: ApiClient;
  tenant: string;
  serviceId: string;
  now?: () => Date;
}) => {
  const { t, f, actor } = usePortalFormat();
  const canManage = useRights().has('manage-services');
  const [state, retry, pending] = useAsync(
    async (signal) => {
      const today = new Date(now());
      today.setHours(0, 0, 0, 0);
      const from = today.toISOString();
      const [environments, definition, keys, clients, changes, all] = await Promise.all([
        api.environments
          .list(tenant, serviceId, signal)
          .catch((e: unknown) =>
            e instanceof ApiError && e.status === 404 ? undefined : Promise.reject(e),
          ),
        api.getDefinition(tenant, 'Service', serviceId, signal),
        api.listServiceKeys(tenant, serviceId, signal).catch(() => undefined),
        api.listClients(tenant, serviceId, signal).catch(() => undefined),
        api.serviceTabs
          .environmentHistory(tenant, serviceId, { limit: 50 }, signal)
          .catch(() => undefined),
        api.tasks(tenant, { service: serviceId, from, limit: 1 }, signal).catch(() => undefined),
      ]);
      const runs = await Promise.allSettled(
        (environments?.environments ?? []).map((e) =>
          api.tasks(tenant, { service: serviceId, environment: e.name, from, limit: 1 }, signal),
        ),
      );
      const active = (keys ?? []).filter((k) => !k.revokedAt);
      const log = changes?.data ?? [];
      const facts: Record<string, EnvironmentFacts> = Object.fromEntries(
        (environments?.environments ?? []).map((e, i) => [
          e.name,
          {
            runsToday: settled(runs[i] as PromiseSettledResult<{ total: number }>)?.total,
            totalToday: all?.total,
            keys: keys
              ? active.filter((k) => !k.environments?.length || k.environments.includes(e.name))
                  .length
              : undefined,
            frontends: clients ? frontendsIn(e.name, clients.clients, active) : undefined,
            since: sinceOf(e.name, e.version, log, definition.versions),
          },
        ]),
      );
      return {
        environments,
        versions: definition.versions,
        facts,
        changes: changes ? log : undefined,
      };
    },
    [api, tenant, serviceId],
    { keepPreviousFor: `${tenant}/${serviceId}` },
  );
  if (state.status === 'loading')
    return <Loading label={t('serviceEnvironments.loading')} shape="list" onRetry={retry} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  const { environments, versions, facts, changes } = state.data;
  if (!environments) return <p className="meta">{t('serviceDev.noEnvironments')}</p>;
  return (
    <div aria-busy={pending || undefined} className="refreshing-host">
      <Environments
        api={api}
        tenant={tenant}
        serviceId={serviceId}
        data={environments}
        versions={versions.map((v) => v.version).reverse()}
        canManage={canManage}
        facts={facts}
        history={
          changes ? environmentHistory(changes, environments, versions, t, f, actor) : undefined
        }
        onChanged={retry}
      />
    </div>
  );
};
