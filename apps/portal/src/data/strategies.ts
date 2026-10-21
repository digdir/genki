import type { Locale } from '@genai/i18n';

export type PlatformStrategyId = string;
export type StrategyHow = 'single' | 'agent' | 'flow';
type ConfigUse = 'required' | 'optional' | 'no';

export interface UiText {
  nb: string;
  en: string;
}

export interface StrategyEntry {
  id: string;
  version: number;
  how: StrategyHow;
  default: boolean;
  title: UiText;
  description: UiText;
  pipeline: { title: UiText; description: UiText; repeats?: true }[];
  newConfig: Record<string, unknown>;
  takes: { instructions: ConfigUse; examples: ConfigUse };
  defaultInstructions?: { text: UiText; note?: UiText };
  schema: string;
}

export interface PlatformStrategy {
  id: PlatformStrategyId;
  version: number;
  how: StrategyHow;
  name: string;
  description: string;
  pipeline: [title: string, description: string, repeats?: boolean][];
}

let catalogue: StrategyEntry[] = [];

export const registerStrategies = (entries: StrategyEntry[]) => {
  catalogue = entries;
};

const localise = (entry: StrategyEntry, locale: Locale): PlatformStrategy => ({
  id: entry.id,
  version: entry.version,
  how: entry.how,
  name: entry.title[locale],
  description: entry.description[locale],
  pipeline: entry.pipeline.map(
    (step) =>
      [
        step.title[locale],
        step.description[locale],
        ...(step.repeats ? [true] : []),
      ] as PlatformStrategy['pipeline'][number],
  ),
});

export const strategiesFor = (t: { locale: Locale } = { locale: 'nb' }): PlatformStrategy[] =>
  catalogue.map((entry) => localise(entry, t.locale));

export const strategyFor = (id: string | undefined, t: { locale: Locale } = { locale: 'nb' }) => {
  const entry = catalogue.find((s) => s.id === id);
  return entry ? localise(entry, t.locale) : undefined;
};

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

export const readPath = (config: Raw, path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (isRaw(v) ? v[k] : undefined), config);

const omit = (config: Raw, key: string): Raw =>
  Object.fromEntries(Object.entries(config).filter(([k]) => k !== key));

export const writePath = (config: Raw, path: string[], value: unknown): Raw => {
  const [head, ...rest] = path;
  if (!head) return config;
  if (rest.length === 0)
    return value === undefined ? omit(config, head) : { ...config, [head]: value };
  const child = writePath(isRaw(config[head]) ? config[head] : {}, rest, value);
  return Object.keys(child).length === 0 ? omit(config, head) : { ...config, [head]: child };
};

export const strategyEntry = (id: string | undefined) => catalogue.find((s) => s.id === id);

export const defaultInstructionsOf = (id: string | undefined, locale: Locale) => {
  const found = strategyEntry(id)?.defaultInstructions;
  return found ? { text: found.text[locale], note: found.note?.[locale] } : undefined;
};

export const takesOf = (id: string | undefined) =>
  strategyEntry(id)?.takes ?? { instructions: 'no' as const, examples: 'no' as const };
