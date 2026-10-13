import type { ApiContext } from '../api';

export type HookPoint =
  | 'before_model'
  | 'after_model'
  | 'before_tool'
  | 'after_tool'
  | 'task_completed'
  | 'on_publish'
  | 'before_search'
  | 'after_search'
  | 'on_feedback';

export type HookHandler =
  | { kind: 'webhook'; url: string; secret: string }
  | { kind: 'builtin'; id: string; config: Record<string, unknown> };

export interface HookSpec {
  name: string;
  point: HookPoint;
  mode: 'observe' | 'annotate' | 'enforce';
  failure: 'open' | 'closed';
  timeoutMs: number;
  order: number;
  enabled: boolean;
  services?: string[];
  handler: HookHandler;
}

export interface Hook extends HookSpec {
  id: string;
  scope: string;
  version: number;
  changedBy: string;
  changedAt: string;
}

export interface BuiltinHookInfo {
  id: string;
  title: string;
  description: string;
}

export interface HookList {
  data: Hook[];
  platform: Hook[];
  points: HookPoint[];
  builtins: BuiltinHookInfo[];
}

export interface HookTrial {
  refused?: { name: string; reason: string };
  records: {
    outcome: string;
    reason?: string;
    annotations?: Record<string, unknown>;
    ms?: number;
  }[];
  payload?: unknown;
}

export const hooksApi = ({ get, request, tenantPath }: ApiContext) => {
  const base = (tenant: string) => `${tenantPath(tenant)}/hooks`;
  const one = (tenant: string, id: string) => `${base(tenant)}/${encodeURIComponent(id)}`;
  const why = (reason: string) => ({ 'change-reason': reason });
  return {
    list: (tenant: string, signal?: AbortSignal) => get<HookList>(base(tenant), signal),
    save: (tenant: string, id: string, spec: HookSpec, reason: string) =>
      request<Hook>('PUT', one(tenant, id), spec, why(reason)),
    remove: (tenant: string, id: string, reason: string) =>
      request<unknown>('DELETE', one(tenant, id), {}, why(reason)),
    test: (tenant: string, id: string) => request<HookTrial>('POST', `${one(tenant, id)}/test`, {}),
  };
};
