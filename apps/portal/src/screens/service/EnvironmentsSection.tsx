import { ApiError, type ApiClient } from '../../api';
import { usePortalFormat } from '../../format';
import { useAsync } from '../../hooks';
import { useRights } from '../../Shell';
import { ErrorState, Loading } from '../../states';
import { Environments } from './Environments';

const settled = <T,>(r: PromiseSettledResult<T>) =>
  r.status === 'fulfilled' ? r.value : undefined;

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
  const { t } = usePortalFormat();
  const canManage = useRights().has('manage-services');
  const [state, retry, pending] = useAsync(
    async (signal) => {
      const [environments, history, keys] = await Promise.all([
        api.environments
          .list(tenant, serviceId, signal)
          .catch((e: unknown) =>
            e instanceof ApiError && e.status === 404 ? undefined : Promise.reject(e),
          ),
        api.getDefinition(tenant, 'Service', serviceId, signal),
        api.listServiceKeys(tenant, serviceId, signal).catch(() => undefined),
      ]);
      const today = new Date(now());
      today.setHours(0, 0, 0, 0);
      const runs = await Promise.allSettled(
        (environments?.environments ?? []).map((e) =>
          api.tasks(
            tenant,
            { service: serviceId, environment: e.name, from: today.toISOString(), limit: 1 },
            signal,
          ),
        ),
      );
      const facts = Object.fromEntries(
        (environments?.environments ?? []).map((e, i) => [
          e.name,
          {
            runsToday: settled(runs[i] as PromiseSettledResult<{ total: number }>)?.total,
            keys: keys?.filter(
              (k) => !k.revokedAt && (!k.environments?.length || k.environments.includes(e.name)),
            ).length,
          },
        ]),
      );
      return { environments, versions: history.versions.map((v) => v.version), facts };
    },
    [api, tenant, serviceId],
    { keepPreviousFor: `${tenant}/${serviceId}` },
  );
  if (state.status === 'loading')
    return <Loading label={t('serviceEnvironments.loading')} shape="list" onRetry={retry} />;
  if (state.status === 'error') return <ErrorState error={state.error} onRetry={retry} />;
  if (!state.data.environments) return <p className="meta">{t('serviceDev.noEnvironments')}</p>;
  return (
    <div aria-busy={pending || undefined} className="refreshing-host">
      <Environments
        api={api}
        tenant={tenant}
        serviceId={serviceId}
        data={state.data.environments}
        versions={[...state.data.versions].reverse()}
        canManage={canManage}
        facts={state.data.facts}
        onChanged={retry}
      />
    </div>
  );
};
