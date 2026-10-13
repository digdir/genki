import type { ApiContext } from '../api';

export type TriggerKind = 'schedule' | 'queue-message' | 'document-arrives';
export type TriggerStatus = 'active' | 'failing' | 'paused';

export interface TriggerRunView {
  id: string;
  at: string;
  outcome: 'completed' | 'failed';
  task?: string;
  error?: string;
  code?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costMicroNok?: number;
  timeline?: string;
}

export interface TriggerView {
  id: string;
  service: string;
  serviceName: string;
  kind: TriggerKind;
  target: string;
  status: TriggerStatus;
  pausedAt?: string;
  pausedBy?: string;
  nextRunAt?: string;
  lastRun?: TriggerRunView;
  runs7d: number;
  failed7d: number;
}

export const triggersApi = ({ get, request, tenantPath }: ApiContext) => {
  const base = (tenant: string) => `${tenantPath(tenant)}/triggers`;
  return {
    list: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data?: TriggerView[] }>(base(tenant), signal)).data ?? [],
    runs: async (tenant: string, id: string, signal?: AbortSignal) =>
      (
        await get<{ trigger: TriggerView; data: TriggerRunView[] }>(
          `${base(tenant)}/${encodeURIComponent(id)}/runs?limit=10`,
          signal,
        )
      ).data,
    pause: (tenant: string, id: string, paused: boolean, reason: string) =>
      request<TriggerView>(
        'PUT',
        `${base(tenant)}/${encodeURIComponent(id)}/pause`,
        { paused },
        { 'change-reason': reason },
      ),
  };
};
