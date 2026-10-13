import { z } from 'zod';
import type { Language } from './language.js';
import { piiCategories } from './pii.js';
import { customRulesConfig } from './rules.js';

const categories = z.array(z.enum(piiCategories)).min(1);

export const piiBeforeModelConfig = z.strictObject({
  categories,
  action: z.enum(['mask', 'refuse']).default('mask'),
  restore: z.boolean().default(true),
  message: z.string().min(1).optional(),
});

export const piiOutOfLogConfig = z.strictObject({ categories });

export const requireSourcesConfig = z.union([
  z.literal(true),
  z.strictObject({ message: z.string().min(1).optional() }),
]);

export const languageConfig = z.strictObject({
  mode: z.enum(['same', 'nb', 'nn', 'en']),
  rewrite: z.boolean().default(true),
});

export const refuseTopicsConfig = z.union([
  z.array(z.string().min(1)).min(1),
  z.strictObject({
    topics: z.array(z.string().min(1)).min(1),
    message: z.string().min(1).optional(),
    onError: z.enum(['refuse', 'allow']).default('refuse'),
  }),
]);

export const humanApprovalConfig = z.union([
  z.literal(true),
  z.strictObject({
    prompt: z.string().min(1).optional(),
    expiresInMinutes: z.number().int().positive().optional(),
    message: z.string().min(1).optional(),
  }),
]);

export const guardrailSchemas = new Map<string, z.ZodType>([
  ['pii-before-model', piiBeforeModelConfig],
  ['pii-out-of-log', piiOutOfLogConfig],
  ['require-sources', requireSourcesConfig],
  ['language', languageConfig],
  ['refuse-topics', refuseTopicsConfig],
  ['human-approval', humanApprovalConfig],
  ['custom-rules', customRulesConfig],
]);

export interface Guardrails {
  piiBeforeModel?: z.infer<typeof piiBeforeModelConfig>;
  piiOutOfLog?: z.infer<typeof piiOutOfLogConfig>;
  requireSources?: { message: string };
  language?: z.infer<typeof languageConfig>;
  refuseTopics?: { topics: string[]; message: string; onError: 'refuse' | 'allow' };
  humanApproval?: { prompt: string; expiresInMinutes?: number; message: string };
  customRules?: unknown[];
}

export const platformMessages = {
  nb: {
    pii: 'Spørsmålet inneholder personopplysninger som ikke kan sendes videre. Fjern dem og prøv igjen.',
    sources: 'Jeg fant ikke kilder som støtter et svar, så jeg svarer ikke på dette.',
    topic: 'Dette spørsmålet kan ikke besvares i denne tjenesten.',
    approval: 'Svaret er laget med kunstig intelligens og må godkjennes før det sendes.',
    rejected: 'Svaret ble ikke godkjent.',
    rule: 'Dette kan ikke besvares i denne tjenesten.',
    disclosure: 'Svaret er laget med kunstig intelligens.',
    unsupported: 'Denne tjenesten svarer ikke på språket i spørsmålet, så jeg svarer på bokmål.',
  },
  nn: {
    pii: 'Spørsmålet inneheld personopplysningar som ikkje kan sendast vidare. Fjern dei og prøv igjen.',
    sources: 'Eg fann ikkje kjelder som støttar eit svar, så eg svarer ikkje på dette.',
    topic: 'Dette spørsmålet kan ikkje svarast på i denne tenesta.',
    approval: 'Svaret er laga med kunstig intelligens og må godkjennast før det blir sendt.',
    rejected: 'Svaret vart ikkje godkjent.',
    rule: 'Dette kan ikkje svarast på i denne tenesta.',
    disclosure: 'Svaret er laga med kunstig intelligens.',
    unsupported: 'Denne tenesta svarer ikkje på språket i spørsmålet, så eg svarer på nynorsk.',
  },
  en: {
    pii: 'The question contains personal data that cannot be passed on. Remove it and try again.',
    sources: 'I found no sources that support an answer, so I will not answer this.',
    topic: 'This question cannot be answered in this service.',
    approval:
      'This answer was made with artificial intelligence and must be approved before it is sent.',
    rejected: 'The answer was not approved.',
    rule: 'This cannot be answered in this service.',
    disclosure: 'This answer was made with artificial intelligence.',
    unsupported:
      'This service does not answer in the language of the question, so I am answering in English.',
  },
} as const satisfies Record<Language, Record<string, string>>;

export const defaultMessages = platformMessages.nb;

export const inLanguage = (text: string, target: Language | undefined) => {
  if (!target || target === 'nb') return text;
  const key = (Object.keys(defaultMessages) as (keyof typeof defaultMessages)[]).find(
    (k) => defaultMessages[k] === text,
  );
  return key ? platformMessages[target][key] : text;
};

export const parseGuardrails = (block: unknown): Guardrails => {
  const raw = (block ?? {}) as Record<string, unknown>;
  const out: Guardrails = {};
  const unknown = Object.keys(raw).filter((k) => !guardrailSchemas.has(k));
  if (unknown.length > 0) throw new Error(`unknown guardrails: ${unknown.join(', ')}`);
  if (raw['pii-before-model'] !== undefined)
    out.piiBeforeModel = piiBeforeModelConfig.parse(raw['pii-before-model']);
  if (raw['pii-out-of-log'] !== undefined)
    out.piiOutOfLog = piiOutOfLogConfig.parse(raw['pii-out-of-log']);
  if (raw['require-sources'] !== undefined) {
    const c = requireSourcesConfig.parse(raw['require-sources']);
    out.requireSources = {
      message: (c === true ? undefined : c.message) ?? defaultMessages.sources,
    };
  }
  if (raw.language !== undefined) out.language = languageConfig.parse(raw.language);
  if (raw['refuse-topics'] !== undefined) {
    const c = refuseTopicsConfig.parse(raw['refuse-topics']);
    out.refuseTopics = Array.isArray(c)
      ? { topics: c, message: defaultMessages.topic, onError: 'refuse' }
      : { topics: c.topics, message: c.message ?? defaultMessages.topic, onError: c.onError };
  }
  if (raw['human-approval'] !== undefined) {
    const c = humanApprovalConfig.parse(raw['human-approval']);
    out.humanApproval = {
      prompt: (c === true ? undefined : c.prompt) ?? defaultMessages.approval,
      message: (c === true ? undefined : c.message) ?? defaultMessages.rejected,
      ...(c !== true && c.expiresInMinutes ? { expiresInMinutes: c.expiresInMinutes } : {}),
    };
  }
  if (raw['custom-rules'] !== undefined)
    out.customRules = customRulesConfig.parse(raw['custom-rules']);
  return out;
};
