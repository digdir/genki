import type { ApiContext } from '../api';
import type { ModelOption } from '../types';

export interface ToolDetail {
  name: string;
  description?: string;
  state: 'approved' | 'pending';
  since?: string;
  approvedBy?: string;
  approvedByName?: string;
  changes?: boolean;
}

export interface ToolConnectionDetail {
  id: string;
  name: string;
  endpoint?: string;
  version?: string;
  tools?: string[];
  toolDetails?: ToolDetail[];
  lastSync?: { at: string; ok: boolean; code?: string; message?: string };
}

export interface ModelOperator {
  name: string;
  region?: string;
}

export interface BlockFacts {
  maker?: string;
  operator?: ModelOperator;
  adoptedAt?: string;
  adoptedBy?: string;
  adoptedByName?: string;
}

export interface FlowDefinition {
  owner: string;
  version: number;
  publishedAt: string;
  definition: unknown;
}

export type ModelWithFacts = ModelOption & Pick<BlockFacts, 'maker' | 'operator'>;

const reasonHeader = (reason: string) => ({ 'change-reason': reason.trim() });

export const blocksApi = (ctx: ApiContext) => {
  const connection = (tenant: string, id: string, rest: string) =>
    `${ctx.tenantPath(tenant)}/tool-connections/${encodeURIComponent(id)}${rest}`;
  return {
    toolConnections: async (tenant: string, signal?: AbortSignal) =>
      (
        await ctx.get<{ data?: ToolConnectionDetail[] }>(
          `${ctx.tenantPath(tenant)}/tool-connections`,
          signal,
        )
      ).data ?? [],
    models: async (signal?: AbortSignal) =>
      (await ctx.get<{ data?: ModelWithFacts[] }>('/models', signal)).data ?? [],
    flowDefinition: (tenant: string, id: string, signal?: AbortSignal) =>
      ctx.get<FlowDefinition>(
        `${ctx.tenantPath(tenant)}/building-blocks/step_flow/${encodeURIComponent(id)}/definition`,
        signal,
      ),
    sync: (tenant: string, id: string, reason: string) =>
      ctx.request<{ active: number; pending: string[] }>(
        'POST',
        connection(tenant, id, '/sync'),
        {},
        reasonHeader(reason),
      ),
    approveTool: (tenant: string, id: string, tool: string, reason: string) =>
      ctx.request<{ approved: string }>(
        'POST',
        connection(tenant, id, '/approve'),
        { tool },
        reasonHeader(reason),
      ),
    revokeTool: (tenant: string, id: string, tool: string, reason: string) =>
      ctx.request<{ revoked: string }>(
        'POST',
        connection(tenant, id, '/revoke'),
        { tool },
        reasonHeader(reason),
      ),
  };
};
