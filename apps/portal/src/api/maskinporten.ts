import type { ApiContext } from '../api';

export interface MaskinportenClient {
  clientId: string;
  name: string;
  services: string[];
  createdAt: string;
}

export interface NewMaskinportenClient {
  clientId: string;
  name: string;
  services: string[];
}

export const maskinportenApi = ({ get, request, tenantPath }: ApiContext) => {
  const clients = (tenant: string) => `${tenantPath(tenant)}/maskinporten-clients`;
  const why = (reason: string) => ({ 'change-reason': reason });
  return {
    list: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data?: MaskinportenClient[] }>(clients(tenant), signal)).data ?? [],
    register: (tenant: string, client: NewMaskinportenClient, reason: string) =>
      request<MaskinportenClient>('POST', clients(tenant), client, why(reason)),
    remove: (tenant: string, clientId: string, reason: string) =>
      request<unknown>(
        'DELETE',
        `${clients(tenant)}/${encodeURIComponent(clientId)}`,
        {},
        why(reason),
      ),
  };
};
