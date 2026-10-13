import type { KnowledgePort } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import { z } from 'zod';
import {
  defaultPlannerPrompt,
  formatConversation,
  groundingPrompt,
  groundingSchema,
  oneCallPrompt,
  planSchema,
  probeStopwords,
} from './prompts.js';

export const plannerConfig = z.strictObject({
  enabled: z.boolean().default(true),
  expansionMode: z
    .enum(['blind', 'corpus-aware-1hop', 'corpus-aware-2hop'])
    .default('corpus-aware-2hop'),
  expansionVariant: z.enum(['two-call', 'one-call']).default('two-call'),
  maxPhrases: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  corpusLanguage: z.string().optional(),
  salientNounCoverage: z.boolean().default(false),
  prompt: z.string().min(1).optional(),
  harvest: z
    .strictObject({
      profile: z.string().min(1).default('phrase'),
      limit: z.number().int().positive().default(12),
      documentField: z.string().min(1).default('doc_num'),
      topDocuments: z.number().int().positive().default(15),
      candidates: z.number().int().positive().default(25),
      rrfK: z.number().positive().default(60),
    })
    .prefault({}),
  retryDelaysMs: z.array(z.number().int().nonnegative()).default([500, 2000, 5000]),
});

export type PlannerConfig = z.infer<typeof plannerConfig>;

export interface PlannerTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface PlanTrace {
  expansionMode: string;
  expansionVariant?: 'one-call';
  fallback?: boolean;
  corpusAwareFallback?: boolean;
  disabled?: boolean;
  hop1PhraseCount?: number;
  hop2PhraseCount?: number;
  hop1Documents?: string[];
  harvestedPhraseCount?: number;
  groundedPhraseCount?: number;
  errors: string[];
}

export interface Plan {
  queries: string[];
  userIntent?: string;
  trace: PlanTrace;
}

export interface PlannerOptions {
  model: ModelPort;
  knowledge?: KnowledgePort;
  config?: unknown;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface Harvested {
  phrase: string;
  document?: string;
  probeRank: number;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

const transientPattern = /timeout|timed out| 429 | 500 | 502 | 503 | 504 /;

export const isTransient = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'rate_limited' || code === 'unavailable') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return transientPattern.test(message);
};

const distinct = (items: (string | undefined)[]) => [
  ...new Set(items.filter((i): i is string => i !== undefined)),
];

const cleanPhrases = (value: unknown) =>
  Array.isArray(value)
    ? distinct(value.map((v) => String(v).trim()).filter((v) => v !== ''))
    : undefined;

export const rrfRank = (harvested: Harvested[], k: number) => {
  const groups = new Map<string, Harvested[]>();
  for (const h of harvested) {
    if (h.phrase.trim() === '') continue;
    const group = groups.get(h.phrase);
    if (group) group.push(h);
    else groups.set(h.phrase, [h]);
  }
  return [...groups]
    .map(([phrase, hits]) => ({
      phrase,
      document: hits[0]?.document,
      rrf: hits.reduce((sum, h) => sum + 1 / (k + h.probeRank + 1), 0),
    }))
    .sort((a, b) => b.rrf - a.rrf || (a.phrase < b.phrase ? -1 : a.phrase > b.phrase ? 1 : 0));
};

export const keywordProbes = (query: string) => {
  const content = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.trim() !== '' && !probeStopwords.has(t) && t.length > 2);
  return distinct([query, content.join(' ')].filter((p) => p.trim() !== ''));
};

export const createPlanner = (options: PlannerOptions) => {
  const config = plannerConfig.parse(options.config ?? {});
  const sleep = options.sleep ?? wait;
  const { model, knowledge } = options;
  const corpusAware = config.expansionMode !== 'blind';
  const twoHop = config.expansionMode === 'corpus-aware-2hop';
  const harvestable =
    knowledge !== undefined && knowledge.info().profiles.includes(config.harvest.profile);

  return async (query: string, history: PlannerTurn[], signal: AbortSignal): Promise<Plan> => {
    const trace: PlanTrace = { expansionMode: config.expansionMode, errors: [] };
    const fallback = (): Plan => ({ queries: [query], trace: { ...trace, fallback: true } });
    if (!config.enabled) return { queries: [query], trace: { ...trace, disabled: true } };

    const withRetries = async <T>(call: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await call();
        } catch (error) {
          if (signal.aborted) throw error;
          const delay = config.retryDelaysMs[attempt];
          if (!isTransient(error) || delay === undefined) throw error;
          await sleep(delay, signal);
        }
      }
    };

    const complete = async (
      prompt: string,
      schema: { name: string; schema: Record<string, unknown> },
      temperature: number,
    ) => {
      try {
        const answer = await withRetries(() =>
          model.chat({
            messages: [{ role: 'user', content: prompt }],
            temperature,
            jsonSchema: schema,
          }),
        );
        try {
          return JSON.parse(answer.content) as Record<string, unknown>;
        } catch (error) {
          trace.errors.push(`could not decode planner output: ${(error as Error).message}`);
          return undefined;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        trace.errors.push(error instanceof Error ? error.message : String(error));
        return undefined;
      }
    };

    const harvest = async (probes: string[], documents?: string[]): Promise<Harvested[]> => {
      if (!knowledge || probes.length === 0) return [];
      const results = await knowledge.searchMany(
        probes.map((q) => ({
          query: q,
          profile: config.harvest.profile,
          limit: config.harvest.limit,
          ...(documents ? { filters: { [config.harvest.documentField]: documents } } : {}),
        })),
      );
      return results.flatMap((r) =>
        r.hits
          .map((h, probeRank) => ({
            phrase: h.text,
            ...(h.document ? { document: h.document } : {}),
            probeRank,
          }))
          .filter((h) => h.phrase.trim() !== ''),
      );
    };

    const harvestCandidates = async (probes: string[]) => {
      try {
        const hop1 = await harvest(probes);
        const hop1Documents = distinct(
          rrfRank(hop1, config.harvest.rrfK).map((r) => r.document),
        ).slice(0, config.harvest.topDocuments);
        const hop2 = twoHop && hop1Documents.length > 0 ? await harvest(probes, hop1Documents) : [];
        const candidates = rrfRank([...hop1, ...hop2], config.harvest.rrfK)
          .map((r) => r.phrase)
          .slice(0, config.harvest.candidates);
        Object.assign(trace, {
          hop1PhraseCount: hop1.length,
          hop2PhraseCount: hop2.length,
          hop1Documents,
          harvestedPhraseCount: candidates.length,
        });
        return candidates;
      } catch (error) {
        if (signal.aborted) throw error;
        trace.errors.push(
          `harvest failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    };

    const cap = Math.max(config.maxPhrases ?? 0, 10);

    if (corpusAware && harvestable && config.expansionVariant === 'one-call') {
      trace.expansionVariant = 'one-call';
      const candidates = await harvestCandidates(keywordProbes(query));
      if (candidates.length === 0)
        return { queries: [query], trace: { ...trace, fallback: true, corpusAwareFallback: true } };
      const parsed = await complete(
        oneCallPrompt(query, candidates),
        planSchema,
        config.temperature ?? 0,
      );
      const phrases = cleanPhrases(parsed?.search_phrases);
      if (!phrases || phrases.length === 0)
        return { queries: [query], trace: { ...trace, fallback: true, corpusAwareFallback: true } };
      const intent =
        typeof parsed?.user_intent === 'string' && parsed.user_intent.trim() !== ''
          ? parsed.user_intent.trim()
          : query;
      trace.groundedPhraseCount = phrases.length;
      return { queries: distinct([intent, ...phrases]).slice(0, cap), userIntent: intent, trace };
    }

    const turns =
      history.length > 0
        ? [...history, { role: 'user' as const, text: query }]
        : [{ role: 'user' as const, text: query }];
    const messages = formatConversation(turns);
    const prompt = (
      config.prompt ??
      defaultPlannerPrompt(messages, config.corpusLanguage, config.salientNounCoverage)
    ).replaceAll('{messages}', messages);
    const parsed = await complete(
      prompt,
      planSchema,
      config.temperature ?? (corpusAware ? 0 : 0.1),
    );
    const userIntent =
      typeof parsed?.user_intent === 'string' && parsed.user_intent.trim() !== ''
        ? parsed.user_intent.trim()
        : undefined;
    const rawPhrases = Array.isArray(parsed?.search_phrases)
      ? parsed.search_phrases.map(String)
      : [];
    const combined = distinct([userIntent, ...rawPhrases]);
    const queries = config.maxPhrases ? combined.slice(0, config.maxPhrases) : combined;
    if (queries.length === 0) return fallback();

    if (corpusAware && userIntent && harvestable) {
      const blindPhrases = queries.slice(1);
      const probes = distinct([userIntent, ...blindPhrases]);
      const candidates = await harvestCandidates(probes);
      if (candidates.length > 0) {
        const grounded = cleanPhrases(
          (
            await complete(
              groundingPrompt(query, blindPhrases, candidates),
              groundingSchema,
              config.temperature ?? 0,
            )
          )?.search_phrases,
        );
        if (grounded) {
          trace.groundedPhraseCount = grounded.length;
          const prf = distinct([userIntent, ...grounded]).slice(0, cap);
          const salient = config.salientNounCoverage ? queries.slice(1, 3) : [];
          return {
            queries: config.salientNounCoverage ? distinct([userIntent, ...salient, ...prf]) : prf,
            userIntent,
            trace,
          };
        }
      }
    }
    return {
      queries,
      ...(userIntent ? { userIntent } : {}),
      trace: corpusAware ? { ...trace, expansionMode: 'blind', corpusAwareFallback: true } : trace,
    };
  };
};
