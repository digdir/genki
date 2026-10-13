import type { ServiceSpec, SpecPatch } from './service-definition';

export const answerLanguages = ['nb', 'nn', 'en'] as const;
export type AnswerLanguage = (typeof answerLanguages)[number];
export type LanguageTexts = Partial<Record<AnswerLanguage, string>>;

export const houseStyleKey = (language: AnswerLanguage) =>
  `answers.languageInstructions.${language}`;

const tree = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const textsOf = (source: (l: AnswerLanguage) => unknown): LanguageTexts =>
  Object.fromEntries(
    answerLanguages.flatMap((l) => {
      const text = source(l);
      return typeof text === 'string' ? [[l, text]] : [];
    }),
  );

const without = (o: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

const withConfig = (spec: ServiceSpec, key: string, value: unknown): SpecPatch => ({
  strategy: {
    ...spec.strategy,
    config:
      value === undefined
        ? without(spec.strategy.config, key)
        : { ...spec.strategy.config, [key]: value },
  },
});

export const languagesOf = (spec: ServiceSpec): AnswerLanguage[] =>
  spec.languages?.length ? spec.languages : ['nb', 'en'];

export const languageInstructionsOf = (spec: ServiceSpec) =>
  textsOf((l) => tree(spec.strategy.config.languageInstructions)[l]);

export const instructionsByLanguageOf = (spec: ServiceSpec) =>
  textsOf((l) => tree(spec.strategy.config.instructions)[l]);

export const perLanguageInstructions = (spec: ServiceSpec) =>
  Object.keys(tree(spec.strategy.config.instructions)).length > 0;

export const sharedInstructionsOf = (spec: ServiceSpec) => {
  const text = spec.strategy.config.instructions;
  return typeof text === 'string' ? text : '';
};

export const houseStyleOf = (spec: ServiceSpec) =>
  textsOf((l) => tree(spec.settings)[houseStyleKey(l)]);

export const withSharedInstructions = (spec: ServiceSpec, text: string): SpecPatch =>
  withConfig(spec, 'instructions', text || undefined);

export const withInstructionsByLanguage = (spec: ServiceSpec, texts: LanguageTexts): SpecPatch =>
  withConfig(spec, 'instructions', texts);

export const withLanguageInstruction = (
  spec: ServiceSpec,
  l: AnswerLanguage,
  text: string | undefined,
): SpecPatch => {
  const texts = without(tree(spec.strategy.config.languageInstructions), l);
  const next = text === undefined ? texts : { ...texts, [l]: text };
  return withConfig(spec, 'languageInstructions', Object.keys(next).length ? next : undefined);
};

export const withHouseStyle = (
  spec: ServiceSpec,
  l: AnswerLanguage,
  text: string | undefined,
): SpecPatch => {
  const settings = without(tree(spec.settings), houseStyleKey(l));
  const next = text === undefined ? settings : { ...settings, [houseStyleKey(l)]: text };
  return { settings: Object.keys(next).length ? next : undefined };
};
