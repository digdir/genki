import type { ApiContext } from '../api';
import type { IntegrationsView, ModelOption } from '../types';

export interface ToolDetail {
  name: string;
  description?: string;
  state: 'approved' | 'pending';
  since?: string;
  approvedBy?: string;
  approvedByName?: string;
  changes: boolean;
}

export interface ToolConnectionDetail {
  id: string;
  name: string;
  endpoint?: string;
  version?: string;
  tools?: string[];
  toolDetails?: ToolDetail[];
  connectedAt?: string;
  connectedByName?: string;
  lastSync?: {
    at: string;
    ok: boolean;
    code?: string;
    message?: string;
    attempts?: number;
    failingSince?: string;
  };
}

export type ToolConnectionView = ToolConnectionDetail & { canRevoke: boolean };

const fromIntegration = (
  connection: ToolConnectionDetail,
  integrations: IntegrationsView | undefined,
): ToolConnectionView => {
  if (connection.toolDetails) return { ...connection, canRevoke: true };
  const found = integrations?.connections.find((c) => c.id === connection.id);
  if (!found) return { ...connection, canRevoke: false };
  return {
    ...connection,
    canRevoke: false,
    toolDetails: [
      ...found.tools.map((tool) => ({ ...tool, state: 'approved' as const, changes: false })),
      ...found.pending.map((tool) => ({ ...tool, state: 'pending' as const, changes: false })),
    ],
  };
};

export interface ModelOperator {
  name: string;
  region?: string;
}

export interface ModelCallType {
  operation: string;
  api: string;
  builtIn?: true;
  maturity?: 'test' | 'production';
}

export type ProcessorFact =
  | { recorded: true; subProcessors: { name: string; location: string }[]; retentionDays: number }
  | { recorded: false };

export interface BlockFacts {
  maker?: string;
  operator?: ModelOperator;
  adoptedAt?: string;
  adoptedBy?: string;
  adoptedByName?: string;
  connection?: string;
  operations?: ModelCallType[];
  processor?: ProcessorFact;
}

export interface FlowDefinition {
  id: string;
  owner: string;
  version: number;
  publishedAt: string;
  yaml: string;
  definition: unknown;
}

export interface InputLimits {
  accepts: string[];
  max_bytes: number;
  max_count: number;
}

export interface ServiceInputs {
  id: string;
  _files?: InputLimits;
  _media?: InputLimits;
}

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'file'; file: { filename: string; file_data: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };

export type ModelWithFacts = ModelOption & Pick<BlockFacts, 'maker' | 'operator'>;

const reasonHeader = (reason: string) => ({ 'change-reason': reason.trim() });

export const blocksApi = (ctx: ApiContext) => {
  const connection = (tenant: string, id: string, rest: string) =>
    `${ctx.tenantPath(tenant)}/tool-connections/${encodeURIComponent(id)}${rest}`;
  return {
    toolConnections: async (tenant: string, signal?: AbortSignal) => {
      const connections =
        (
          await ctx.get<{ data?: ToolConnectionDetail[] }>(
            `${ctx.tenantPath(tenant)}/tool-connections`,
            signal,
          )
        ).data ?? [];
      const integrations = connections.every((c) => c.toolDetails)
        ? undefined
        : await ctx
            .get<IntegrationsView>(`${ctx.tenantPath(tenant)}/integrations`, signal)
            .catch(() => undefined);
      return connections.map((c) => fromIntegration(c, integrations));
    },
    models: async (signal?: AbortSignal) =>
      (await ctx.get<{ data?: ModelWithFacts[] }>('/models?all=true', signal)).data ?? [],
    serviceInputs: async (signal?: AbortSignal) =>
      (await ctx.get<{ data?: ServiceInputs[] }>('/v1/models', signal)).data ?? [],
    runShared: async (publicName: string, content: string | ChatPart[]) => {
      const reply = await ctx.request<{ choices: { message: { content: string } }[] }>(
        'POST',
        '/v1/chat/completions',
        { model: publicName, messages: [{ role: 'user', content }] },
      );
      return reply.choices[0]?.message.content ?? '';
    },
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
