import type { BlockData } from '@genai/contracts/block-fields';
import type {
  BlockDetail,
  BlockState,
  BlockSummary,
  BlockZone,
  RefBlockPayload,
} from '@genai/contracts/blocks';
import type { ApiContext } from '../api';

export type { BlockDetail, BlockSummary, RefBlockPayload };

export interface FieldProblem {
  path: string;
  message: string;
}

export interface BlockPreview {
  valid: boolean;
  errors?: FieldProblem[];
  render?: RefBlockPayload;
  reads: string[];
  fixtures: Partial<Record<BlockState, BlockData>>;
}

export interface PinnedDraft {
  revision: number;
  definition: Record<string, unknown>;
  files: Record<string, string>;
  baseVersion: number | null;
  checks: FieldProblem[];
}

export interface ImportNote {
  kind: 'converted' | 'dropped' | 'text' | 'data';
  code: string;
  where: string;
  message: string;
}

export interface ImportResult {
  tier: 'declarative';
  definition: Record<string, unknown>;
  files: Record<string, string>;
  report: ImportNote[];
}

export interface ShareRequest {
  id: string;
  status: 'pending' | 'approved' | 'declined';
  version: number;
  at: string;
}

const why = (reason: string) => ({ 'change-reason': reason.trim() });

export const designApi = ({ get, request, tenantPath }: ApiContext) => {
  const blocks = (tenant: string) => `${tenantPath(tenant)}/blocks`;
  const pinPath = (tenant: string, service: string, publisher: string, id: string) =>
    `${tenantPath(tenant)}/services/${encodeURIComponent(service)}/draft/blocks/${encodeURIComponent(publisher)}/${encodeURIComponent(id)}`;
  return {
    list: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data: BlockSummary[] }>(blocks(tenant), signal)).data,
    detail: (
      tenant: string,
      publisher: string,
      id: string,
      version?: number,
      signal?: AbortSignal,
    ) =>
      get<BlockDetail>(
        `${blocks(tenant)}/${encodeURIComponent(publisher)}/${encodeURIComponent(id)}${
          version === undefined ? '' : `?version=${version}`
        }`,
        signal,
      ),
    files: async (tenant: string, id: string, version: number) =>
      (
        await get<{ files?: Record<string, string> }>(
          `${tenantPath(tenant)}/definitions/blocks/${encodeURIComponent(id)}/versions/${version}`,
        )
      ).files ?? {},
    preview: (
      tenant: string,
      definition: Record<string, unknown>,
      files: Record<string, string> = {},
      states?: BlockState[],
    ) =>
      request<BlockPreview>('POST', `${blocks(tenant)}/preview`, {
        definition,
        files,
        ...(states ? { states } : {}),
      }),
    save: (definition: Record<string, unknown>, files: Record<string, string>, reason: string) =>
      request<{ version: number }>('POST', '/definitions', { definition, files }, why(reason)),
    importDesign: (tenant: string, body: { html: string; id: string; title?: string }) =>
      request<ImportResult>('POST', `${blocks(tenant)}/import`, body),
    requestShare: (tenant: string, id: string, version: number, reason: string) =>
      request<ShareRequest>(
        'POST',
        `${blocks(tenant)}/${encodeURIComponent(id)}/share-requests`,
        { version },
        why(reason),
      ),
    archive: (tenant: string, id: string, reason: string) =>
      request<{ id: string; archived: true; version: number }>(
        'DELETE',
        `${blocks(tenant)}/${encodeURIComponent(id)}`,
        undefined,
        why(reason),
      ),
    pin: (
      tenant: string,
      service: string,
      target: { publisher: string; id: string },
      body: { version: number; zone?: BlockZone; settings?: Record<string, boolean | string> },
      reason: string,
    ) =>
      request<PinnedDraft>(
        'PUT',
        pinPath(tenant, service, target.publisher, target.id),
        body,
        why(reason),
      ),
    unpin: (
      tenant: string,
      service: string,
      target: { publisher: string; id: string },
      reason: string,
    ) =>
      request<PinnedDraft>(
        'DELETE',
        pinPath(tenant, service, target.publisher, target.id),
        {},
        why(reason),
      ),
  };
};
