import type { ApiContext } from '../api';

export interface EnvironmentView {
  name: string;
  version: number | null;
  followsPublishes: boolean;
  previousVersion: number | null;
}

export interface ServiceEnvironments {
  environments: EnvironmentView[];
  latestVersion: number;
}

export const productionEnvironment = 'prod';
export const environmentNamePattern = /^[a-z][a-z0-9-]{0,31}$/;

export const environmentsApi = ({ get, request, tenantPath }: ApiContext) => {
  const base = (tenant: string, service: string) =>
    `${tenantPath(tenant)}/services/${encodeURIComponent(service)}/environments`;
  const one = (tenant: string, service: string, name: string) =>
    `${base(tenant, service)}/${encodeURIComponent(name)}`;
  return {
    list: (tenant: string, service: string, signal?: AbortSignal) =>
      get<ServiceEnvironments>(base(tenant, service), signal),
    add: (tenant: string, service: string, name: string, reason: string) =>
      request<ServiceEnvironments>(
        'POST',
        base(tenant, service),
        { name },
        { 'change-reason': reason },
      ),
    remove: (tenant: string, service: string, name: string, reason: string) =>
      request<ServiceEnvironments>(
        'DELETE',
        one(tenant, service, name),
        {},
        { 'change-reason': reason },
      ),
    promote: (tenant: string, service: string, name: string, from: string, reason: string) =>
      request<ServiceEnvironments>(
        'POST',
        `${one(tenant, service, name)}/promote`,
        { from },
        { 'change-reason': reason },
      ),
    rollback: (tenant: string, service: string, name: string, version: number, reason: string) =>
      request<ServiceEnvironments>(
        'POST',
        `${one(tenant, service, name)}/rollback`,
        { version },
        { 'change-reason': reason },
      ),
  };
};
