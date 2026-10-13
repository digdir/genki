import type { JSONSchema, Part, Ref } from '@genai/contracts';
import type { PortContext, PortProvider } from '@genai/kernel';
import { z } from 'zod';

export interface ToolDefinition {
  name: string;
  version: string;
  description: string;
  input: JSONSchema;
  origin: 'builtin' | 'mcp' | 'a2a' | 'openapi';
}

export interface Source {
  id: string;
  title?: string;
  url?: string;
  document?: string;
  position?: number;
  text?: string;
}

export interface ToolResult {
  parts: Part[];
  sources?: Source[];
  isError?: boolean;
}

export interface ToolPort {
  definition(): ToolDefinition;
  call(input: unknown): Promise<ToolResult>;
}

export interface BuiltinTool<I = unknown> {
  name: string;
  version: string;
  description: string;
  input: z.ZodType<I>;
  run(input: I, ctx: PortContext): Promise<ToolResult>;
}

export interface ToolSource {
  resolve(name: string, version: string, ctx: PortContext, owner: string): ToolPort | undefined;
}

export type ToolErrorCode = 'not_found' | 'bad_input' | 'failed' | 'cancelled';

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

const refPattern = /^([a-z0-9][a-z0-9._-]*)@(\d+(?:\.\d+){0,2})$/;

export const parseToolRef = (id: string): { name: string; version: string } => {
  const match = refPattern.exec(id);
  if (!match?.[1] || !match[2])
    throw new ToolError('not_found', `a tool reference is name@version, not ${id}`);
  return { name: match[1], version: match[2] };
};

export const toolRef = (name: string, version: string, tenant?: string): Ref => ({
  kind: 'tool',
  id: `${name}@${version}`,
  ...(tenant ? { tenant } : {}),
});

export const errorResult = (message: string): ToolResult => ({
  parts: [{ mime: 'text/plain', body: { kind: 'text', text: message } }],
  isError: true,
});

const builtinPort = <I>(tool: BuiltinTool<I>, ctx: PortContext): ToolPort => {
  const definition: ToolDefinition = {
    name: tool.name,
    version: tool.version,
    description: tool.description,
    input: z.toJSONSchema(tool.input) as JSONSchema,
    origin: 'builtin',
  };
  return {
    definition: () => definition,
    call: async (input) => {
      const parsed = tool.input.safeParse(input);
      if (!parsed.success) {
        return errorResult(
          `Invalid input for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
        );
      }
      if (ctx.signal.aborted) throw new ToolError('cancelled', 'the tool call was cancelled');
      await ctx.meter({ requests: 1 });
      try {
        return await tool.run(parsed.data, ctx);
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (ctx.signal.aborted) throw new ToolError('cancelled', 'the tool call was cancelled');
        throw new ToolError('failed', error instanceof Error ? error.message : String(error));
      }
    },
  };
};

export class ToolRegistry implements PortProvider<ToolPort> {
  readonly #builtins = new Map<string, BuiltinTool<never>>();
  readonly #sources: ToolSource[] = [];

  register<I>(tool: BuiltinTool<I>): this {
    parseToolRef(`${tool.name}@${tool.version}`);
    const key = `${tool.name}@${tool.version}`;
    if (this.#builtins.has(key)) throw new Error(`tool ${key} is already registered`);
    this.#builtins.set(key, tool as unknown as BuiltinTool<never>);
    return this;
  }

  addSource(source: ToolSource): this {
    this.#sources.push(source);
    return this;
  }

  refs(): string[] {
    return [...this.#builtins.keys()].sort();
  }

  open(ref: Ref, ctx: PortContext): ToolPort {
    if (ref.kind !== 'tool') throw new ToolError('not_found', `not a tool reference: ${ref.kind}`);
    const { name, version } = parseToolRef(ref.id);
    const builtin = this.#builtins.get(ref.id);
    if (builtin) return builtinPort(builtin as BuiltinTool<unknown>, ctx);
    for (const source of this.#sources) {
      const port = source.resolve(name, version, ctx, ref.tenant ?? ctx.tenant);
      if (port) return port;
    }
    throw new ToolError('not_found', `no tool ${ref.id}`);
  }
}

export const textOf = (result: ToolResult): string =>
  result.parts
    .map((p) =>
      p.body.kind === 'text'
        ? p.body.text
        : p.body.kind === 'json'
          ? JSON.stringify(p.body.json)
          : '',
    )
    .filter((t) => t.length > 0)
    .join('\n\n');
