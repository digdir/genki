import { residencies, type Residency } from '@genai/port-model';
import { t, translate, type ApiKey } from './i18n/index.js';

export const retiredModelMessage = 'Modellen tjenesten bruker er tatt ut av bruk';

export interface ModelState {
  id: string;
  residency: string;
  enabled: boolean;
}

export interface ServiceModels {
  primary?: string;
  fallback?: string;
  roles?: Record<string, string | undefined>;
  residency?: string;
}

export interface ServiceWarning {
  model: string;
  message: string;
}

export interface ServiceHealth {
  status: 'active' | 'paused';
  reason?: string;
  warnings: ServiceWarning[];
}

const placeKeys: Record<Residency, ApiKey> = {
  norway: 'services.placeNorway',
  eu: 'services.placeEu',
  global: 'services.placeGlobal',
};

const place = (residency: string) => {
  const key = placeKeys[residency as Residency];
  return key ? translate(key) : residency;
};

const rank = (residency: string) => residencies.indexOf(residency as Residency);

export const serviceHealth = (
  models: ServiceModels | undefined,
  states: ModelState[],
): ServiceHealth => {
  const byId = new Map(states.map((m) => [m.id, m]));
  const warnings: ServiceWarning[] = [];
  const primary = models?.primary ? byId.get(models.primary) : undefined;
  const others = [
    models?.fallback,
    ...Object.values(models?.roles ?? {}).filter((id) => id !== models?.primary),
  ].filter((id): id is string => typeof id === 'string');
  for (const id of new Set(others))
    if (byId.get(id)?.enabled === false)
      warnings.push({ model: id, message: t('services.modelRetired', { id }) });
  for (const model of [primary, ...others.map((id) => byId.get(id))]) {
    if (!model?.enabled || !models?.residency) continue;
    if (rank(model.residency) > rank(models.residency))
      warnings.push({
        model: model.id,
        message: t('services.modelReclassified', {
          id: model.id,
          place: place(model.residency),
          required: place(models.residency),
        }),
      });
  }
  if (primary && !primary.enabled)
    return { status: 'paused', reason: t('services.primaryRetired', { id: primary.id }), warnings };
  return { status: 'active', warnings };
};
