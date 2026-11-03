import { retentionClasses } from '@genai/kernel';
import { z } from 'zod';
import { catalogueSettings } from './settings-catalogue.js';
import type { Layer, SettingDefinition } from './settings.js';

export interface Consumer {
  package: string;
  field: string;
}

export interface PlatformSetting<T = unknown> extends SettingDefinition<T> {
  consumers: Consumer[];
}

const platformAndTenant: Layer[] = ['platform', 'tenant'];

/** Heavy knowledge work runs only inside this window, Europe/Oslo time (ADR 0042, "Heavy work"). */
export const defaultNightWindow = '01:00-06:00';
export const nightWindowPattern = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
/** Lets heavy work run at any hour, set by an operator to fill datasets before go-live. */
export const alwaysNightWindow = 'always';
/** Work above this many chunks is heavy and waits for the night window (ADR 0042, "Heavy work"). */
export const defaultHeavyThreshold = 100_000;
export const maxLanguageInstructionChars = 4000;
export const languageInstructionsSetting = (language: string) =>
  `answers.languageInstructions.${language}`;

const setting = <T>(
  key: string,
  schema: z.ZodType<T>,
  defaultValue: T,
  category: string,
  description: string,
): PlatformSetting<T> => ({
  key,
  schema,
  default: defaultValue,
  category,
  description,
  consumers: [],
  axis: 'service',
  sensitivity: 'normal',
  settableAt: platformAndTenant,
});

export const nativeSettings: PlatformSetting[] = [
  setting(
    'knowledge.switchRetentionDays',
    z.number().int().min(1).max(365),
    14,
    'knowledge',
    'Days the previous search engine copy is kept after a dataset switches engine.',
  ),
  {
    ...setting(
      'knowledge.nightWindow',
      z.union([
        z.literal(alwaysNightWindow),
        z
          .string()
          .regex(nightWindowPattern, 'written as 01:00-06:00, or always')
          .refine((window) => window.slice(0, 5) !== window.slice(6), 'starts when it ends'),
      ]),
      defaultNightWindow,
      'knowledge',
      'Hours (Europe/Oslo) in which heavy knowledge work runs: index builds, large fills and VACUUM. `always` lets it run at any hour, as before a go-live.',
    ),
    settableAt: ['platform'],
  },
  {
    ...setting(
      'knowledge.heavyThreshold',
      z.number().int().min(1).max(1_000_000_000),
      defaultHeavyThreshold,
      'knowledge',
      'Chunks above which an index build, a fill or a VACUUM is heavy work and waits for the night window.',
    ),
    settableAt: ['platform'],
  },
  setting(
    'assistant.enabled',
    z.boolean(),
    true,
    'assistant',
    'Offer the builder assistant in the service builder.',
  ),
  setting(
    'assistant.dailyTokens',
    z.number().int().min(0).max(10_000_000),
    200_000,
    'assistant',
    'Tokens the builder assistant may use per tenant each day; resets at midnight Oslo time.',
  ),
  setting(
    'assistant.model',
    z.string(),
    '',
    'assistant',
    'Catalog model the builder assistant uses; empty picks the first enabled model with tools within the allowed residency.',
  ),
  setting(
    'services.defaultModel',
    z.string(),
    '',
    'models',
    'Catalog model new services start with; empty picks the cheapest priced model the tenant may use.',
  ),
  {
    ...setting(
      'answers.writtenStandard',
      z.enum(['user', 'bokmal', 'nynorsk']),
      'user',
      'answers',
      'Written standard for answers: user matches the question (nynorsk or bokmål), or always bokmal or nynorsk. A person who reads English gets English unless the service or call sets this. A service guardrail language wins.',
    ),
    settableAt: ['platform', 'tenant', 'service', 'call'],
  },
  ...(
    [
      [
        'nb',
        'Svar på bokmål. Skriv klarspråk: korte setninger, aktive verb, forklar fagord første gang de brukes, og ikke bruk engelske ord når det finnes gode norske.',
        'House style for answers in bokmål, added after the service instructions.',
      ],
      [
        'nn',
        'Svar på nynorsk.',
        'House style for answers in nynorsk, added after the service instructions.',
      ],
      [
        'en',
        'Answer in English. Keep the Norwegian names of agencies, laws and services, and explain each briefly the first time it appears.',
        'House style for answers in English, added after the service instructions.',
      ],
    ] as const
  ).map(([language, text, description]): PlatformSetting => ({
    ...setting(
      `answers.languageInstructions.${language}`,
      z.string().max(maxLanguageInstructionChars),
      text,
      'answers',
      description,
    ),
    settableAt: ['platform', 'tenant', 'service'],
  })),
  setting(
    'skills.defaultPassThreshold',
    z.number().min(0).max(1),
    0.9,
    'skills',
    'Share of test cases a skill must pass to publish when its test set sets no threshold.',
  ),
  setting(
    'skills.testModel',
    z.string(),
    '',
    'skills',
    'Catalog model that runs skill test sets; empty picks the cheapest model the tenant may use.',
  ),
  setting(
    'skills.judgeModel',
    z.string(),
    '',
    'skills',
    'Catalog model that judges skill test answers; empty picks the cheapest model the tenant may use from another family.',
  ),
  setting(
    'playground.enabled',
    z.boolean(),
    true,
    'playground',
    'Offer the playground for trying services, skills and building blocks.',
  ),
  setting(
    'usage.monthlyTokens',
    z.number().int().min(1),
    50_000_000,
    'usage',
    'Tokens a tenant may use per calendar month; the playground refuses runs once it is used up.',
  ),
  setting(
    'batch.approvalLimitNok',
    z.number().min(0).max(1_000_000),
    150,
    'usage',
    'Kroner a batch run may be estimated to cost before someone who manages services must approve it with a reason; 0 turns approval off.',
  ),
  {
    ...setting(
      'retention.class',
      z.enum(retentionClasses),
      'standard',
      'retention',
      'How long prompts, answers and documents are kept after a task ends: transient 7 days, standard 90, case 365. High-risk services keep them at least 183 days, limited-risk at least 30.',
    ),
    settableAt: ['platform', 'tenant', 'service'],
  },
  setting(
    'retention.auditDays',
    z.number().int().min(183).max(3650),
    730,
    'retention',
    'Days the audit envelope of a task (ids, type, actor, usage, versions, times) is kept after it ends; never shorter than the content.',
  ),
  setting(
    'usage.tenantCallsPerMinute',
    z.number().int().min(1),
    600,
    'usage',
    'Calls per minute a tenant may make across all its keys and people.',
  ),
];

export const platformSettings: PlatformSetting[] = [...catalogueSettings, ...nativeSettings];

export const platformSettingByKey = new Map(platformSettings.map((s) => [s.key, s]));
