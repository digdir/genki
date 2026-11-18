import type { ApiContext } from '../api';

export type ComponentStatus = 'normal' | 'degraded' | 'down';

export interface TenantStatus {
  incidents: { title: string; text: string }[];
  components: {
    name: string;
    status: ComponentStatus;
    errorRate?: string;
    p95?: string;
    note?: string;
  }[];
  queueStats: { label: string; value: string }[];
  queue: {
    type: string;
    what: string;
    status: 'running' | 'waiting' | 'failed';
    age: string;
    at: string;
  }[];
  triggers: {
    tenant: string;
    what: string;
    error: string;
    failedAt: string;
    lastSuccess?: string;
  }[];
}

export interface PastIncident {
  date: string;
  title: string;
  text: string;
}

export const platformStatusApi = ({ get, tenantPath }: ApiContext) => ({
  tenant: async (tenant: string, signal?: AbortSignal): Promise<TenantStatus> => {
    const found = await get<Partial<TenantStatus> & { pastIncidents?: PastIncident[] }>(
      `${tenantPath(tenant)}/status`,
      signal,
    );
    return {
      incidents: found.incidents ?? [],
      components: found.components ?? [],
      queueStats: found.queueStats ?? [],
      queue: found.queue ?? [],
      triggers: found.triggers ?? [],
      ...(found.pastIncidents ? { pastIncidents: found.pastIncidents } : {}),
    };
  },
});
