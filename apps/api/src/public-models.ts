import type { SettingsRegistry } from '@genai/definitions';
import type { ModelDescription } from '@genai/port-model';
import { blockStatusFor, type BlockPolicy } from './building-blocks.js';
import { defaultModelSetting } from './service-template.js';

export const recommendedModelsSetting = 'models.recommended';

export type ModelUnavailableReason = 'not_allowed' | 'requires_approval';

const valueOf = (settings: Pick<SettingsRegistry, 'effective'>, tenant: string, key: string) => {
  try {
    return settings.effective(tenant)[key]?.value;
  } catch {
    return undefined;
  }
};

export const recommendedModels = (
  settings: Pick<SettingsRegistry, 'effective'>,
  tenant: string,
): Set<string> => {
  const listed = valueOf(settings, tenant, recommendedModelsSetting);
  const ids = Array.isArray(listed)
    ? listed.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (ids.length > 0) return new Set(ids);
  const fallback = valueOf(settings, tenant, defaultModelSetting);
  return new Set(typeof fallback === 'string' && fallback ? [fallback] : []);
};

export const unavailableReason = (
  policy: BlockPolicy | undefined,
  model: Pick<ModelDescription, 'id' | 'residency'>,
): ModelUnavailableReason | undefined => {
  if (!policy) return undefined;
  const { status } = blockStatusFor(policy, {
    kind: 'model',
    id: model.id,
    dataLocation: model.residency,
  });
  if (status === 'not_allowed') return 'not_allowed';
  if (status === 'requires_approval' || status === 'pending_approval') return 'requires_approval';
  return undefined;
};
