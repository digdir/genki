import { answerLanguages } from '@genai/port-model';
import {
  defaultServiceLanguages,
  languageInstruction,
  servesLanguage,
  type Language,
} from './language.js';

export type HouseStyleLayer = 'default' | 'platform' | 'tenant' | 'service';

export interface HouseStyle {
  text: string;
  layer: HouseStyleLayer;
}

export interface AnswerLanguageProvenance {
  answer: Language;
  layers: string[];
  textHash: string;
  fallback?: true;
}

type Texts = Partial<Record<Language, string>>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isLanguage = (v: unknown): v is Language =>
  typeof v === 'string' && (answerLanguages as readonly string[]).includes(v);

export const serviceLanguagesOf = (config: unknown): Language[] => {
  const listed = isObject(config) && Array.isArray(config.languages) ? config.languages : [];
  const languages = listed.filter(isLanguage);
  return languages.length > 0 ? languages : defaultServiceLanguages;
};

export interface LanguageChoice {
  language: Language | undefined;
  fallback: boolean;
}

export const chooseLanguage = (
  chosen: Language | undefined,
  asked: Language | 'unknown',
  languages: readonly Language[],
): LanguageChoice => {
  const wanted = chosen ?? (asked === 'unknown' ? undefined : asked);
  if (!wanted) return { language: undefined, fallback: false };
  return servesLanguage(languages, wanted)
    ? { language: wanted, fallback: false }
    : { language: languages[0] ?? 'nb', fallback: true };
};

export const writesText = (config: unknown) => {
  const kind = isObject(config) && isObject(config.output) ? config.output.kind : undefined;
  return kind === undefined || kind === 'answer';
};

const textsOf = (value: unknown): Texts =>
  isObject(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (e): e is [Language, string] => isLanguage(e[0]) && typeof e[1] === 'string',
        ),
      )
    : {};

export interface LanguageAssembly {
  config: unknown;
  instruction: string | undefined;
  layers: string[];
}

const pick = (texts: Texts, order: (Language | undefined)[]) => {
  for (const l of order) if (l && texts[l] !== undefined) return { language: l, text: texts[l] };
  return undefined;
};

export const assembleLanguage = (
  config: unknown,
  language: Language | undefined,
  houseStyle: HouseStyle | undefined,
): LanguageAssembly => {
  if (!isObject(config) || !isObject(config.strategy))
    return {
      config,
      instruction: houseStyle?.text,
      layers: houseStyle ? [`house-style@${houseStyle.layer}`] : [],
    };
  const languages = serviceLanguagesOf(config);
  const { languageInstructions, ...strategy } = config.strategy;
  const layers: string[] = [];
  if (isObject(strategy.instructions)) {
    const own = pick(textsOf(strategy.instructions), [
      language,
      language === 'nn' ? 'nb' : undefined,
      ...languages,
      ...answerLanguages,
    ]);
    if (own) {
      strategy.instructions = own.text;
      layers.push(`instructions.${own.language}`);
    }
  } else if (typeof strategy.instructions === 'string') layers.push('instructions');
  if (!language) return { config: { ...config, strategy }, instruction: undefined, layers };
  const serviceText = textsOf(languageInstructions)[language];
  if (houseStyle) layers.push(`house-style@${houseStyle.layer}`);
  if (serviceText) layers.push(`language-instructions.${language}`);
  const parts = [houseStyle?.text, serviceText].filter((t): t is string => Boolean(t?.trim()));
  return {
    config: { ...config, strategy },
    instruction: parts.length > 0 ? parts.join('\n\n') : undefined,
    layers,
  };
};

export const defaultHouseStyle = (language: Language): HouseStyle => ({
  text: languageInstruction[language],
  layer: 'default',
});

export const textHash = async (texts: (string | undefined)[]) => {
  const bytes = new TextEncoder().encode(JSON.stringify(texts));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};
