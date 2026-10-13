import type { ModelOption } from './types';

export const modelLabel = (id: string, models: Pick<ModelOption, 'id' | 'name'>[] = []) =>
  models.find((m) => m.id === id)?.name ?? id.slice(id.lastIndexOf('/') + 1);
