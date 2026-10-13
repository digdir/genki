import type { UiSchema } from '@genai/schema-forms';
import type { ApiContext } from '../api';

export interface Recipe {
  ref: string;
  id: string;
  version: number;
  origin: 'own' | 'shared';
  shared?: boolean;
  name?: string;
  title: { nb: string; en: string };
  summary: { nb: string; en: string };
  purpose: string;
  settings: UiSchema;
  steps: Record<string, unknown>[];
}

export const recipesApi = ({ get, tenantPath }: ApiContext) => ({
  list: async (tenant: string, signal?: AbortSignal) =>
    (await get<{ recipes: Recipe[] }>(`${tenantPath(tenant)}/step-flows/recipes`, signal)).recipes,
  version: async (tenant: string, id: string, version: number, signal?: AbortSignal) =>
    (
      await get<{ recipe: Recipe }>(
        `${tenantPath(tenant)}/step-flows/recipes/${encodeURIComponent(id)}/versions/${version}`,
        signal,
      )
    ).recipe,
});
