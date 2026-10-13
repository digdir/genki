import type { ApiClient } from './api';
import { useAsync } from './hooks';
import { translator, useT, type T } from './i18n';

const spaced = (n: string) => n.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3');

export const tenantLabel = (orgNumber: string, name?: string, t: T = translator('nb')) =>
  name && name !== orgNumber
    ? name
    : /^\d{9}$/.test(orgNumber)
      ? t('common.orgNumberName', { number: spaced(orgNumber) })
      : orgNumber;

export const useTenantNames = (api: ApiClient) => {
  const t = useT();
  const [tenants] = useAsync((signal) => api.listTenants(signal), [api]);
  const names = new Map(
    tenants.status === 'ready' ? tenants.data.map((t) => [t.orgNumber, t.name]) : [],
  );
  return (orgNumber: string) => tenantLabel(orgNumber, names.get(orgNumber), t);
};
