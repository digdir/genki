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

export const settingsMock = ({
  catalog = [],
  extras = exampleSettingExtras,
}: {
  catalog?: SettingInfo[];
  extras?: SettingInfo[];
} = {}): MockHandler => {
  return (req) => {
    if (req.method !== 'GET' || req.path !== '/settings') return undefined;
    const known = new Set(catalog.map((s) => s.key));
    return req.json({ data: [...catalog, ...extras.filter((s) => !known.has(s.key))] });
  };
};
