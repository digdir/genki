import { tenantSecretPattern } from '@genai/providers-mcp-client';
import { z } from 'zod';
import { remoteResidencies } from './contract.js';

const secret = z
  .string()
  .regex(tenantSecretPattern, 'must be a tenant secret reference, secret://tenant/<orgnr>/<name>');

export const remoteEndpoint = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  protocol: z.enum(['http', 'a2a']).default('http'),
  residency: z.enum(remoteResidencies),
  auth: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('bearer'), secret }),
      z.strictObject({
        kind: z.literal('header'),
        header: z.string().regex(/^[A-Za-z0-9-]+$/),
        secret,
      }),
    ])
    .optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .default(2 * 1024 * 1024),
});

export const remoteAgentConfig = z
  .strictObject({
    endpoint: remoteEndpoint.optional(),
    agent: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'the id of a registered agent plug-in')
      .optional(),
    send: z
      .strictObject({
        history: z.boolean().default(true),
        maxMessages: z.number().int().min(0).max(100).default(20),
        identity: z.enum(['none', 'subject']).default('none'),
        metadata: z.array(z.string().min(1)).max(50).default([]),
      })
      .prefault({}),
  })
  .refine((c) => (c.endpoint === undefined) !== (c.agent === undefined), {
    path: ['endpoint'],
    message: 'name either an endpoint or a registered agent, not both',
  });

export type RemoteAgentConfig = z.output<typeof remoteAgentConfig>;
export type RemoteEndpoint = z.output<typeof remoteEndpoint>;
