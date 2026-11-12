import type { ApiClient } from './api';
import type { T } from './i18n';

export class SecretHostsProblem extends Error {}

export const hostsToStore = async (
  api: ApiClient,
  tenant: string,
  name: string,
  origin: string,
  t: T,
): Promise<string[] | undefined> => {
  const known = await api.buildingBlocks.secrets(tenant).catch(() => {
    throw new SecretHostsProblem(t('secretHosts.unchecked', { name }));
  });
  const hosts = known.find((s) => s.name === name)?.allowedHosts ?? [];
  if (hosts.length === 0) return [origin];
  if (!hosts.includes(origin))
    throw new SecretHostsProblem(t('secretHosts.setElsewhere', { name, hosts: hosts.join(', ') }));
  return undefined;
};
