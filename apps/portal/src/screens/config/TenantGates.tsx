import type { ApiClient, ConfigEntry } from '../../api';
import { useT, type T } from '../../i18n';
import { Registry } from './Registry';

export const gateTemplate = {
  metric: '',
  kind: 'threshold',
  threshold: 0.7,
  maxRegression: 0,
  perTag: false,
  split: 'validation',
};

const describe = (t: T, e: ConfigEntry) => {
  const s = e.spec as { metric?: string; kind?: string; threshold?: number };
  return [
    s.metric,
    s.kind === 'threshold'
      ? t('config.gateAtLeast', { threshold: s.threshold ?? 0 })
      : t('config.gateNoRegression'),
  ]
    .filter(Boolean)
    .join(' · ');
};

export const TenantGates = ({ api, tenant }: { api: ApiClient; tenant: string }) => {
  const t = useT();
  const base = `/tenants/${encodeURIComponent(tenant)}/gates`;
  return (
    <Registry
      api={api}
      scope={tenant}
      label={t('config.gatesLabel')}
      paths={{
        list: base,
        item: (id) => `${base}/${encodeURIComponent(id)}`,
        history: (id) => `${base}/${encodeURIComponent(id)}/versions`,
      }}
      template={gateTemplate}
      mandatory
      describe={(e) => describe(t, e)}
    />
  );
};
