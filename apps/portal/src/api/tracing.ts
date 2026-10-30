import type { ApiContext } from '../api';

export type Residency = 'norway' | 'eu' | 'global';

export interface TraceConnectionInput {
  host: string;
  publicKey: string;
  secretKey: string;
  services: string[];
  residency: Residency;
  content: boolean;
  erasureDeclared: boolean;
}

export interface TraceConnection extends TraceConnectionInput {
  id: string;
  instance: boolean;
  residencySetBy: 'operator' | 'tenant';
  removing?: boolean;
}

export const tracingApi = ({ get, request, tenantPath }: ApiContext) => {
  const base = (tenant: string) => `${tenantPath(tenant)}/tracing/connections`;
  const one = (tenant: string, id: string) => `${base(tenant)}/${encodeURIComponent(id)}`;
  const why = (reason: string) => ({ 'change-reason': reason });
  return {
    list: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data: TraceConnection[] }>(base(tenant), signal)).data,
    save: (tenant: string, id: string, connection: TraceConnectionInput, reason: string) =>
      request<TraceConnection>('PUT', one(tenant, id), connection, why(reason)),
    remove: (tenant: string, id: string, reason: string) =>
      request<unknown>('DELETE', one(tenant, id), {}, why(reason)),
    check: (tenant: string, id: string) =>
      request<{ ok: true; project: { id: string; name: string } }>(
        'POST',
        `${one(tenant, id)}/check`,
        {},
      ),
  };
};
