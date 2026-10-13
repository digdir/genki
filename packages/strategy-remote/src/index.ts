import type { Input, Part, Usage } from '@genai/contracts';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import { z } from 'zod';
import { remoteAgentConfig, type RemoteEndpoint } from './config.js';
import { remoteAgentContract, type RemoteReply, type RemoteRequest } from './contract.js';
import { RemoteAgentError, type RemoteTransport } from './transport.js';

export * from './config.js';
export * from './contract.js';
export * from './transport.js';

export const remoteAgentRuntimeConfig = z.looseObject({
  strategy: remoteAgentConfig,
  output: z.looseObject({ kind: z.enum(['answer', 'fields', 'document', 'table']) }),
});

const SOURCES_MIME = 'application/vnd.genai.sources+json';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const messagesOf = (data: unknown): RemoteRequest['messages'] => {
  const history = isRecord(data) ? data.history : undefined;
  return (Array.isArray(history) ? history : []).flatMap((turn) => {
    const { role, text } = isRecord(turn) ? turn : {};
    return (role === 'user' || role === 'assistant') && typeof text === 'string' && text.trim()
      ? [{ role, text }]
      : [];
  });
};

const usageKeys = [
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'requests',
  'costMicroNok',
] as const;

const usageOf = (reply: RemoteReply): Usage => ({
  ...Object.fromEntries(
    usageKeys.flatMap((key) => {
      const value = reply.usage?.[key];
      return typeof value === 'number' ? [[key, value]] : [];
    }),
  ),
  requests: reply.usage?.requests ?? 1,
});

const queryOf = (input: Input) => {
  const data = isRecord(input.data) ? input.data : {};
  const fromParts = (input.parts ?? [])
    .flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : []))
    .join('\n')
    .trim();
  const query = typeof data.query === 'string' && data.query.trim() ? data.query : fromParts;
  if (!query) throw new Error('remote-agent needs a question');
  return query;
};

const requestFor = (
  ctx: InvocationContext,
  input: Input,
  config: z.infer<typeof remoteAgentConfig>,
): RemoteRequest => {
  const data = isRecord(input.data) ? input.data : {};
  const query = queryOf(input);
  const earlier = config.send.history ? messagesOf(data).slice(-config.send.maxMessages) : [];
  return {
    contract: remoteAgentContract,
    conversation: { id: ctx.thread ?? ctx.task, task: ctx.task },
    query,
    messages: [...earlier, { role: 'user', text: query }],
    context: {
      tenant: ctx.capability.tenant,
      caller: { tenant: ctx.tenant },
      service: { id: ctx.capability.id, version: ctx.capability.version },
      ...(config.send.identity === 'subject'
        ? {
            principal: {
              kind: ctx.principal.kind,
              subject: ctx.principal.subject,
              ...(ctx.principal.tenant ? { tenant: ctx.principal.tenant } : {}),
            },
          }
        : {}),
    },
    metadata: Object.fromEntries(
      config.send.metadata.flatMap((name) => (name in data ? [[name, data[name]]] : [])),
    ),
  };
};

const partsOf = (reply: RemoteReply, kind: string): Part[] => {
  const parts: Part[] = [];
  if (kind === 'fields') {
    if (!isRecord(reply.data))
      throw new RemoteAgentError(
        'bad_reply',
        'the remote agent returned no data for a fields output',
      );
    parts.push({ mime: 'application/json', body: { kind: 'json', json: reply.data } });
  } else {
    if (typeof reply.answer !== 'string')
      throw new RemoteAgentError('bad_reply', 'the remote agent returned no answer');
    parts.push({ mime: 'text/plain', body: { kind: 'text', text: reply.answer } });
  }
  if (reply.sources?.length)
    parts.push({
      mime: SOURCES_MIME,
      body: {
        kind: 'json',
        json: {
          sources: reply.sources.map((s) => ({
            chunkId: s.id,
            ...(s.title ? { title: s.title } : {}),
            ...(s.url ? { url: s.url } : {}),
            ...(s.text ? { text: s.text } : {}),
            ...(s.document ? { document: s.document } : {}),
            ...(s.position === undefined ? {} : { position: s.position }),
          })),
        },
      },
    });
  return parts;
};

const shown = (reply: RemoteReply): Emitted[] =>
  (reply.steps ?? []).map((step) => ({
    type: 'kernel.notice',
    data: {
      kind: 'external-step',
      origin: 'remote-agent',
      title: step.title,
      ...(step.summary ? { summary: step.summary } : {}),
      ok: step.status !== 'failed',
      ...(step.status === 'skipped' ? { skipped: true } : {}),
      ...(step.durationMs === undefined ? {} : { ms: Math.round(step.durationMs) }),
    },
  }));

export interface RegisteredAgent {
  endpoint: RemoteEndpoint;
  owner: string;
}

export const createRemoteAgent = (options: {
  transport: RemoteTransport;
  agents?: (id: string) => RegisteredAgent | undefined;
}): Strategy<unknown> => ({
  id: 'remote-agent',
  version: '1',
  requires: { kernel: 1, ports: [], features: [] },

  run: async function* (ctx, input, raw) {
    const config = remoteAgentRuntimeConfig.parse(raw);
    const named = config.strategy.agent;
    const registered = named ? options.agents?.(named) : undefined;
    if (named && !registered) throw new RemoteAgentError('refused', `no registered agent ${named}`);
    const endpoint = registered?.endpoint ?? (config.strategy.endpoint as RemoteEndpoint);
    if (config.output.kind === 'document' || config.output.kind === 'table')
      throw new Error(`remote-agent cannot produce ${config.output.kind} output`);
    const started = Date.now();
    const host = new URL(endpoint.url).hostname;
    let reply: RemoteReply;
    try {
      reply = await options.transport.call({
        endpoint,
        owner: registered?.owner ?? ctx.capability.tenant,
        request: requestFor(ctx, input, config.strategy),
        signal: ctx.signal,
      });
    } catch (error) {
      yield {
        type: 'kernel.notice',
        data: {
          kind: 'external-step',
          origin: 'remote-agent',
          host,
          ok: false,
          ms: Date.now() - started,
        },
      };
      throw error;
    }
    await ctx.budget.charge(usageOf(reply));
    yield* shown(reply);
    yield {
      type: 'kernel.notice',
      data: {
        kind: 'external-step',
        origin: 'remote-agent',
        host,
        ok: true,
        ms: Date.now() - started,
        steps: reply.steps?.length ?? 0,
      },
    };
    yield { type: 'kernel.result', data: partsOf(reply, config.output.kind) };
  },
});
export * from './schema-labels.js';
