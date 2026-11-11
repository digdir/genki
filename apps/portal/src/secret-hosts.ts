import type { ApiClient } from './api';

export const storedSecretHosts = async (
  api: ApiClient,
  tenant: string,
  name: string,
): Promise<string[] | undefined> => {
  const known = await api.buildingBlocks.secrets(tenant).catch(() => undefined);
  return known && (known.find((s) => s.name === name)?.allowedHosts ?? []);
};
