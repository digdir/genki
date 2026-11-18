import type { ApiContext } from '../api';

export const quotaRequestPendingType = 'urn:genai:problem:quota-request-pending';

export interface QuotaRequestView {
  id: string;
  monthlyTokens: number;
  reason: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  state: 'pending' | 'approved' | 'rejected';
  decision?: { by: string; byName?: string; at: string; reason: string };
}

export const quotaRequestsApi = ({ get, request, tenantPath }: ApiContext) => {
  const base = (tenant: string) => `${tenantPath(tenant)}/quota-requests`;
  return {
    list: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data?: QuotaRequestView[] }>(base(tenant), signal)).data ?? [],
    create: (tenant: string, monthlyTokens: number, reason: string) =>
      request<QuotaRequestView>(
        'POST',
        base(tenant),
        { monthlyTokens },
        { 'change-reason': reason },
      ),
  };
};
