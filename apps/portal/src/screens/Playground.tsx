import { PlaygroundPanel } from '../components/playground/PlaygroundPanel';
import { useAsync } from '../hooks';
import { useT } from '../i18n';
import type { ScreenProps } from '../screen';
import { PageLoading } from '../states';

const ServicePlayground = ({
  api,
  tenant,
  tenantName,
  service,
}: Omit<ScreenProps, 'route' | 'live'> & { service: string }) => {
  const t = useT();
  const [draft, retry] = useAsync(
    (signal) => api.quality.draft(tenant, service, signal).catch(() => undefined),
    [api, tenant, service],
  );
  if (draft.status !== 'ready')
    return <PageLoading label={t('playground.loadingSetup')} shape="detail" onRetry={retry} />;
  return (
    <PlaygroundPanel
      layout="page"
      context="service"
      name={service}
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      {...(draft.data
        ? { serviceDraft: { definition: draft.data.definition, files: draft.data.files } }
        : {})}
    />
  );
};

export const Playground = ({ api, tenant, tenantName, route }: ScreenProps) => {
  const service = route.query.get('service');
  return service ? (
    <ServicePlayground
      key={service}
      api={api}
      tenant={tenant}
      tenantName={tenantName}
      service={service}
    />
  ) : (
    <PlaygroundPanel layout="page" api={api} tenant={tenant} tenantName={tenantName} />
  );
};
