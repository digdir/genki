import { z } from 'zod';

export const remoteAgentContract = 'remote-agent/v1';

export const remoteResidencies = ['norway', 'eu', 'global'] as const;

const text = (max: number) => z.string().max(max);

export const remoteRequest = z.strictObject({
  contract: z.literal(remoteAgentContract),
  conversation: z.strictObject({ id: z.string(), task: z.string() }),
  query: z.string(),
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), text: z.string() })),
  context: z.strictObject({
    tenant: z.string(),
    caller: z.strictObject({ tenant: z.string() }),
    service: z.strictObject({ id: z.string(), version: z.string() }),
    principal: z
      .strictObject({ kind: z.string(), subject: z.string(), tenant: z.string().optional() })
      .optional(),
  }),
  metadata: z.record(z.string(), z.unknown()),
});

export type RemoteRequest = z.infer<typeof remoteRequest>;

export const remoteReply = z.looseObject({
  answer: text(200_000).optional(),
  data: z.unknown().optional(),
  sources: z
    .array(
      z.looseObject({
        id: z.string().min(1),
        title: text(500).optional(),
        url: text(2000).optional(),
        text: text(20_000).optional(),
        document: text(500).optional(),
        position: z.number().int().optional(),
      }),
    )
    .max(200)
    .optional(),
  steps: z
    .array(
      z.looseObject({
        title: text(200).min(1),
        summary: text(500).optional(),
        status: z.enum(['done', 'failed', 'skipped']).optional(),
        durationMs: z.number().nonnegative().optional(),
      }),
    )
    .max(50)
    .optional(),
  usage: z
    .looseObject({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      requests: z.number().int().nonnegative().optional(),
      costMicroNok: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export type RemoteReply = z.infer<typeof remoteReply>;
