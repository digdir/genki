export interface RouteCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

const seg = encodeURIComponent;

export const accessRequestsPath = '/onboarding/requests';

export type SettingCallInput =
  | { kind: 'tenant'; tenant: string; key: string; value: unknown; reset: boolean }
  | { kind: 'service'; tenant: string; service: string; key: string; value: unknown }
  | { kind: 'serviceDraft'; tenant: string; service: string; key: string; value: unknown }
  | { kind: 'dataset' };

export const settingCall = (input: SettingCallInput): RouteCall | undefined => {
  if (input.kind === 'dataset') return undefined;
  if (input.kind === 'tenant')
    return input.reset
      ? { method: 'DELETE', path: `/tenants/${seg(input.tenant)}/settings/${seg(input.key)}` }
      : {
          method: 'PUT',
          path: `/tenants/${seg(input.tenant)}/settings/${seg(input.key)}`,
          body: { value: input.value },
        };
  return {
    method: 'POST',
    path: input.kind === 'service' ? '/definitions' : '/definitions/validate',
    body: {
      definition: {
        kind: 'Service',
        metadata: { tenant: input.tenant, id: input.service },
        spec: { settings: { [input.key]: input.value } },
      },
    },
  };
};

export const datasetRunCall = (tenant: string, dataset: string, pipeline: string): RouteCall => ({
  method: 'POST',
  path: `/tenants/${seg(tenant)}/datasets/${seg(dataset)}/pipelines/${pipeline === '{pipeline}' ? pipeline : seg(pipeline)}/execute`,
  body: {},
});
