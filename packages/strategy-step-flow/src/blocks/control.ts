import { textPart, type Part } from '@genai/contracts';
import { z } from 'zod';
import type { Block } from '../blocks.js';
import { SOURCES_MIME } from './retrieval.js';

const templateInput = z.looseObject({ text: z.string() });

export const templateBlock: Block<z.infer<typeof templateInput>, Record<string, never>> = {
  name: 'template',
  version: '1',
  description: 'Render text from earlier steps with {{references}}',
  input: templateInput,
  params: z.strictObject({}),
  output: z.strictObject({ text: z.string() }),
  run: async function* (_ctx, input) {
    yield* [];
    return { text: input.text };
  },
};

const routeParams = z.strictObject({ queue: z.string().min(1) });

export const routeBlock: Block<Record<string, unknown>, z.infer<typeof routeParams>> = {
  name: 'route',
  version: '1',
  description: 'Record which queue an item goes to',
  input: z.looseObject({}),
  params: routeParams,
  output: z.strictObject({ queue: z.string() }),
  run: async function* (ctx, _input, params) {
    yield { type: 'kernel.notice', data: { kind: 'route', step: ctx.step, queue: params.queue } };
    return { queue: params.queue };
  },
};

const approvalParams = z.strictObject({ reason: z.string().min(1), prompt: z.string().min(1) });

export const approvalBlock: Block<Record<string, unknown>, z.infer<typeof approvalParams>> = {
  name: 'approval',
  version: '1',
  description: 'Pause the flow until a person answers, then continue with their answer',
  input: z.looseObject({}),
  params: approvalParams,
  output: z.looseObject({ approved: z.boolean() }),
  run: async function* (ctx, _input, params) {
    yield* [];
    if (!ctx.resumed)
      return { pause: { reason: params.reason, prompt: [textPart(params.prompt)] } };
    const response = ctx.resumed.response;
    const approved =
      typeof response === 'object' && response !== null && 'approved' in response
        ? (response as { approved: unknown }).approved !== false
        : true;
    return { approved, response: response ?? null, parts: ctx.resumed.parts };
  },
};

const agentInput = z.looseObject({
  query: z.string().min(1),
  history: z.array(z.looseObject({ role: z.string(), text: z.string() })).optional(),
});
const agentParams = z.strictObject({
  variant: z.enum(['bundled', 'faithful']).default('bundled'),
  agent: z.record(z.string(), z.unknown()).default({}),
  retrieval: z.record(z.string(), z.unknown()).optional(),
});

const textOf = (parts: Part[]) =>
  parts.flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : [])).join('\n');

const sourcesOf = (parts: Part[]) =>
  parts.flatMap((p) =>
    p.mime === SOURCES_MIME && p.body.kind === 'json'
      ? ((p.body.json as { sources?: unknown[] }).sources ?? [])
      : [],
  );

export const agentBlock: Block<z.infer<typeof agentInput>, z.infer<typeof agentParams>> = {
  name: 'agent',
  version: '1',
  description: 'Run the agent loop (search, read, answer) as one step',
  input: agentInput,
  params: agentParams,
  output: z.looseObject({ parts: z.array(z.unknown()), text: z.string() }),
  run: async function* (ctx, input, params) {
    const agent = ctx.services.agent;
    if (!agent)
      throw new Error(`step ${ctx.step} needs the agent strategy, and none is configured`);
    const base = ctx.config.knowledge ?? {};
    const config = {
      ...ctx.config,
      strategy: params.agent,
      ...(params.retrieval
        ? { knowledge: { ...base, retrieval: { ...(base.retrieval ?? {}), ...params.retrieval } } }
        : {}),
    };
    yield {
      type: 'kernel.notice',
      data: { kind: 'step', step: ctx.step, stage: 'agent', variant: params.variant },
    };
    let parts: Part[] = [];
    const run = agent.run(
      ctx.invocation,
      {
        data: { query: input.query, history: input.history ?? [] },
        parts: [textPart(input.query)],
      },
      config,
    );
    for await (const event of run) {
      if (event.type === 'kernel.result') parts = event.data as Part[];
      else yield event;
    }
    return { parts, text: textOf(parts), sources: sourcesOf(parts) };
  },
};
