import type { ApiContext } from '../api';
import type { PortalRight } from '../types';

export interface AccessPerson {
  id: string;
  name: string;
  rights: PortalRight[];
}

export interface AccessPeopleView {
  people: AccessPerson[];
  at: string;
  stale: boolean;
  source: 'altinn' | 'test-data' | 'entra-groups';
}

export interface AccessMember {
  id: string;
  name: string;
}

export interface ServiceAccess {
  id: string;
  mode: 'all' | 'selected';
  members: AccessMember[];
  by?: string;
  byName?: string;
  at?: string;
  reason?: string;
}

export type ServiceAccessChange = { mode: 'all' } | { mode: 'selected'; members: string[] };

export const accessApi = ({ get, request, tenantPath }: ApiContext) => ({
  people: async (tenant: string, signal?: AbortSignal) => {
    const view = await get<Partial<AccessPeopleView>>(
      `${tenantPath(tenant)}/access/people`,
      signal,
    );
    if (!Array.isArray(view.people)) throw new Error('no people in the answer');
    return view as AccessPeopleView;
  },
  services: async (tenant: string, signal?: AbortSignal) =>
    (await get<{ services?: ServiceAccess[] }>(`${tenantPath(tenant)}/access/services`, signal))
      .services ?? [],
  limit: (tenant: string, service: string, change: ServiceAccessChange, reason: string) =>
    request<ServiceAccess>(
      'PUT',
      `${tenantPath(tenant)}/access/services/${encodeURIComponent(service)}`,
      change,
      { 'change-reason': reason },
    ),
});
