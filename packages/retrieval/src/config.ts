import { knowledgeProfiles } from '@genai/port-knowledge';
import { z } from 'zod';
import { defaultStrategyWeights, mergeModes } from './merge.js';
import { autoFilterRule } from './rules.js';
import { unionModes } from './stages.js';

export const enrichmentTypes = [
  'hypothetical-questions',
  'verified-phrases',
  'fact-assertions',
] as const;

const strategy = z.strictObject({
  name: z.string().min(1),
  profiles: z.array(z.string().min(1)).min(1),
});

export const retrievalConfig = z.strictObject({
  mode: z.enum(['multi-strategy', 'hierarchical']).default('multi-strategy'),
  enrichment: z
    .array(
      z.strictObject({
        type: z.enum(enrichmentTypes),
        profiles: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
  strategies: z
    .array(strategy)
    .min(1)
    .default([
      { name: 'phrase', profiles: [knowledgeProfiles.phrase] },
      { name: 'metadata', profiles: [knowledgeProfiles.metadata] },
      { name: 'content', profiles: [knowledgeProfiles.content] },
    ]),
  docTitle: z
    .strictObject({
      profiles: z.array(z.string().min(1)).default([]),
      fanout: z.number().int().positive().max(50).default(3),
      maxDocs: z.number().int().positive().default(40),
    })
    .optional(),
  limit: z.number().int().positive().default(30),
  retrieveTopK: z.number().int().positive().default(100),
  maxPerDocument: z.number().int().positive().optional(),
  metadataOnly: z.boolean().default(false),
  queryAwareBoost: z.boolean().default(true),
  autoFilter: z
    .strictObject({
      enabled: z.boolean().default(true),
      orgFields: z.array(z.string()).default(['orgs_long', 'orgs_short']),
      yearTitleField: z.string().default('title'),
      minValueLength: z.number().int().positive().default(3),
      cacheTtlMs: z.number().int().nonnegative().default(300_000),
      rules: z.array(autoFilterRule).default([]),
    })
    .prefault({}),
  duplicateFiles: z.enum(['when-content', 'always', 'never']).default('when-content'),
  merge: z
    .strictObject({
      mode: z.enum(mergeModes).default('weighted-sum'),
      weights: z.record(z.string(), z.number()).default({}),
      caps: z.record(z.string(), z.number().int().positive()).default({}),
      rrfK: z.number().int().positive().default(60),
    })
    .prefault({}),
  boostWeights: z
    .strictObject({
      titleOverlapPerToken: z.number().default(0.03),
      titleOverlapMax: z.number().default(0.3),
      contentOverlapPerToken: z.number().default(0.04),
      contentOverlapMax: z.number().default(0.4),
      yearMatch: z.number().default(0.15),
      orgFilterMatch: z.number().default(0.4),
      contentSearchType: z.number().default(0.35),
      phraseSearchType: z.number().default(0.08),
      metadataSearchType: z.number().default(0.05),
      numericEvidence: z.number().default(0.45),
      originalRankWeight: z.number().default(0.1),
    })
    .prefault({}),
  diversity: z
    .strictObject({
      relaxMinTotal: z.number().int().default(30),
      relaxMinDocs: z.number().int().default(3),
      relaxMinTopDocCount: z.number().int().default(20),
      relaxMinTopDocShare: z.number().default(0.45),
      relaxedMaxPerDocument: z.number().int().positive().default(50),
      defaultMaxPerDocument: z.number().int().positive().default(10),
    })
    .prefault({}),
  rerank: z
    .strictObject({
      enabled: z.boolean().default(false),
      candidateK: z.number().int().positive().default(40),
      maxChunkLength: z.number().int().positive().default(2000),
      windowing: z.boolean().default(true),
      snippetLength: z.number().int().positive().default(220),
      perStrategy: z.boolean().default(false),
      finalCap: z.number().int().positive().default(40),
    })
    .prefault({}),
  userIntentUnion: z
    .strictObject({
      enabled: z.boolean().default(false),
      mode: z.enum(unionModes).default('cap'),
      cap: z.number().int().positive().default(3),
      rrfK: z.number().int().positive().default(60),
    })
    .prefault({}),
  batchSize: z.number().int().positive().default(50),
});

export type RetrievalConfig = z.infer<typeof retrievalConfig>;

export const strategyWeights = (config: RetrievalConfig) => ({
  ...defaultStrategyWeights,
  ...(config.enrichment.length > 0 ? Object.fromEntries(enrichmentTypes.map((t) => [t, 0.7])) : {}),
  ...config.merge.weights,
});
