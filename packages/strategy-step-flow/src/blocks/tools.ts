import type { Part } from '@genai/contracts';
import { textOf, toolRef, ToolError, type Source, type ToolPort } from '@genai/port-tools';
import { z } from 'zod';
import type { Block } from '../blocks.js';

const toolParams = z.strictObject({
  source: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
});

const toolOutput = z.strictObject({
  text: z.string(),
  json: z.unknown(),
  parts: z.array(z.unknown()),
  sources: z.array(z.unknown()),
  source: z.string(),
  tool: z.string(),
});

const jsonOf = (parts: Part[], text: string): unknown => {
  for (const part of parts) if (part.body.kind === 'json') return part.body.json;
  if (!/^\s*[[{]/.test(text)) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

const withTimeout = <T>(work: Promise<T>, ms: number, what: string) => {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolError('failed', `${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  work.catch(() => undefined);
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
};

export const toolBlock: Block<Record<string, unknown>, z.infer<typeof toolParams>> = {
  name: 'tool',
  version: '1',
  description: 'Call one tool from a registered tool source and keep its result for later steps',
  input: z.looseObject({}),
  params: toolParams,
  output: toolOutput,
  run: async function* (ctx, _input, params) {
    const name = `${params.source}.${params.tool}`;
    const ref = (ctx.config.tools ?? []).find((r) => r.slice(0, r.lastIndexOf('@')) === name);
    if (!ref)
      throw new Error(`step ${ctx.step}: the service has no tool ${name}; add it under spec.tools`);
    const at = ref.lastIndexOf('@');
    const started = Date.now();
    const notice = (ok: boolean, extra: Record<string, unknown> = {}) => ({
      type: 'kernel.notice',
      data: {
        kind: 'external-step',
        origin: 'tool',
        step: ctx.step,
        tool: name,
        ok,
        ms: Date.now() - started,
        arguments: Object.keys(params.arguments),
        ...extra,
      },
    });
    try {
      const port = await ctx.invocation.use<ToolPort>(
        'tools',
        toolRef(
          ref.slice(0, at),
          ref.slice(at + 1),
          ctx.config.model?.tenant ?? ctx.invocation.tenant,
        ),
      );
      const result = await withTimeout(
        port.call(params.arguments),
        params.timeoutMs,
        `tool ${name}`,
      );
      const text =
        result.parts.flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : [])).join('\n\n') ||
        textOf(result);
      if (result.isError) throw new Error(`tool ${name} reported an error: ${text.slice(0, 400)}`);
      const sources: Source[] = result.sources ?? [];
      yield notice(true, { sources: sources.length });
      return {
        text,
        json: jsonOf(result.parts, text),
        parts: result.parts,
        sources,
        source: params.source,
        tool: params.tool,
      };
    } catch (error) {
      if (!ctx.invocation.signal.aborted) yield notice(false);
      throw error;
    }
  },
};
