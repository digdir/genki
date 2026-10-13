import { accessRequestsPath } from '../data/api-calls';
import type { ApiContext } from '../api';

export type AccessRequestStatus = 'pending' | 'approved' | 'rejected';

export interface AccessRequestInput {
  org: string;
  orgName: string;
  contactName: string;
  contactEmail: string;
  purpose: string;
  acceptedTerms: true;
}

export interface AccessRequest {
  id: string;
  org: string;
  status: AccessRequestStatus | (string & {});
  requestedAt: string;
  contactEmail?: string;
  decision?: { by: string; at: string; reason: string };
  decidedAt?: string;
  reason?: string;
}

export interface OrganisationAccessStatus {
  org: string;
  registered: boolean;
  mayRequest: boolean;
  pendingRequest: { requestedAt: string; mine: boolean } | null;
}

const requestsPath = accessRequestsPath;
export { requestsPath };

export const onboardingApi = ({ get, request }: ApiContext) => ({
  requestAccess: (input: AccessRequestInput) =>
    request<{ id: string; status: AccessRequestStatus }>('POST', requestsPath, input),
  myRequests: async (signal?: AbortSignal) =>
    (await get<{ data: AccessRequest[] }>(`${requestsPath}/mine`, signal)).data,
  organisationStatus: (org: string, signal?: AbortSignal) =>
    get<OrganisationAccessStatus>(`/onboarding/organisations/${encodeURIComponent(org)}`, signal),
});
