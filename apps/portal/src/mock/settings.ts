import type { SettingOverride } from '../api/settings';
import type { MockHandler } from '../mock';
import type { SettingInfo } from '../types';

export const sourcesSettingKey = 'answers.showSources';

export const exampleSettingExtras: SettingInfo[] = [
  {
    key: sourcesSettingKey,
    description: 'Vis alltid hvilke dokumenter svaret bygger på.',
    category: 'answers',
    axis: 'service',
    sensitivity: 'normal',
    default: true,
    settableAt: ['platform', 'tenant', 'service'],
  },
  {
    key: 'retention.class',
    description: 'Hvor lenge spørsmål og svar lagres.',
    category: 'retention',
    axis: 'service',
    sensitivity: 'normal',
    default: 'standard',
    settableAt: ['platform', 'tenant', 'service'],
    schema: { type: 'string', enum: ['transient', 'standard', 'case'] },
  },
];

export const exampleSettingOverrides: Record<string, SettingOverride[]> = {
  'retention.class': [
    { service: 'klarsprak', name: 'Klarspråk', value: 'transient' },
    { service: 'rapportassistenten', name: 'Rapportassistenten', value: 'case' },
  ],
};

export const settingsMock = ({
  catalog = [],
  extras = exampleSettingExtras,
  overrides = exampleSettingOverrides,
}: {
  catalog?: SettingInfo[];
  extras?: SettingInfo[];
  overrides?: Record<string, SettingOverride[]>;
} = {}): MockHandler => {
  return (req) => {
    if (req.method !== 'GET') return undefined;
    if (req.path === '/settings') {
      const known = new Set(catalog.map((s) => s.key));
      return req.json({ data: [...catalog, ...extras.filter((s) => !known.has(s.key))] });
    }
    const m = /^\/tenants\/[^/]+\/settings\/([^/]+)\/overrides$/.exec(req.path);
    if (!m) return undefined;
    return req.json({ data: overrides[decodeURIComponent(m[1] ?? '')] ?? [] });
  };
};
