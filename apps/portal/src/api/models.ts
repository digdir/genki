import type { ApiContext } from '../api';
import type { ModelOption } from '../types';

export type ModelUnavailableReason = 'not_allowed' | 'requires_approval';

export interface CatalogModel extends ModelOption {
  maker?: string;
  operator?: { name: string; region?: string };
  contextWindow?: number;
  releaseDate?: string;
  recommended?: boolean;
  available?: boolean;
  reason?: ModelUnavailableReason;
}

export const modelsApi = (ctx: ApiContext) => ({
  catalog: async (signal?: AbortSignal) =>
    (await ctx.get<{ data?: CatalogModel[] }>('/models?all=true', signal)).data ?? [],
});
