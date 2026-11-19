import type { ReactNode } from 'react';
import type { ApiClient } from './api';
import { registerStrategies } from './data/strategies';
import { useAsync } from './hooks';
import { useT } from './i18n';
import { Loading } from './states';

export const StrategyCatalogue = ({
  api,
  tenant,
  children,
  fallback,
}: {
  api: ApiClient;
  tenant: string;
  children: ReactNode;
  fallback?: ReactNode;
}) => {
  const t = useT();
  const [state] = useAsync((signal) => api.listStrategies(tenant, signal), [api, tenant]);
  if (state.status === 'loading')
    return fallback ?? <Loading label={t('app.loadingStrategies')} shape="service" />;
  registerStrategies(state.status === 'ready' ? state.data : []);
  return children;
};
