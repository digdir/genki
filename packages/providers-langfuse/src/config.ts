import { secretRefPattern, withoutTrailingSlashes } from '@genai/kernel';
import { z } from 'zod';

const secret = z.string().regex(secretRefPattern, 'must be a secret:// reference');

export const exporterConfig = z.strictObject({
  endpoint: z.url(),
  auth: z
    .discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('langfuse'),
        publicKey: z.string().min(1),
        secretKey: secret,
      }),
      z.strictObject({ kind: z.literal('header'), name: z.string().min(1), secret }),
      z.strictObject({ kind: z.literal('none') }),
    ])
    .default({ kind: 'none' }),
  content: z.boolean().default(false),
  /** With content: only these fields of an eval run's case, the ones its judges map (ADR 0040). */
  fields: z.array(z.enum(['input', 'output', 'expected_output'])).optional(),
  sampleRate: z.number().min(0).max(1).default(1),
  environment: z.string().min(1).optional(),
  pseudonymKey: secret.optional(),
  batch: z
    .strictObject({
      maxSpans: z.number().int().positive().default(100),
      intervalMs: z.number().int().positive().default(2000),
      maxQueue: z.number().int().positive().default(10_000),
      maxRetries: z.number().int().min(0).default(5),
      backoffMs: z.number().int().positive().default(500),
    })
    .prefault({}),
  limits: z
    .strictObject({
      openTasks: z.number().int().positive().default(10_000),
      eventsPerTask: z.number().int().positive().default(2_000),
    })
    .prefault({}),
});

export type ExporterConfigInput = z.input<typeof exporterConfig>;
export type ExporterConfig = z.output<typeof exporterConfig>;

export const tracesUrl = (endpoint: string) =>
  withoutTrailingSlashes(endpoint).endsWith('/v1/traces')
    ? endpoint
    : `${withoutTrailingSlashes(endpoint)}/v1/traces`;
