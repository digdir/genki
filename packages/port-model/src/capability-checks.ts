import type { Usage } from '@genai/contracts';
import {
  capabilities,
  ModelError,
  type Capability,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
} from './port.js';

export interface CapabilityCheck {
  has: boolean;
  at: string;
  by: 'listing' | 'call';
}

export type LearnedCapabilities = Partial<Record<Capability, CapabilityCheck>>;

/** Reasoning is left out: no answer shows whether a model reasoned. */
export const checkedCapabilities: readonly Capability[] = ['json-schema', 'tools', 'stream'];

export interface CheckOutcome {
  has?: boolean;
  usage?: Usage;
  calls: number;
}

const question = 'What colour is a clear daytime sky? Answer in one word.';

const jsonSchemaCheck: ChatRequest = {
  messages: [{ role: 'user', content: question }],
  maxTokens: 256,
  jsonSchema: {
    name: 'capability_check',
    schema: {
      type: 'object',
      properties: { colour: { type: 'string' } },
      required: ['colour'],
      additionalProperties: false,
    },
  },
};

const toolsCheck: ChatRequest = {
  messages: [{ role: 'user', content: `${question} Give it with the record_answer tool.` }],
  maxTokens: 256,
  tools: [
    {
      name: 'record_answer',
      description: 'Records the answer to the question.',
      parameters: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    },
  ],
};

const streamCheck: ChatRequest = { messages: [{ role: 'user', content: question }], maxTokens: 64 };

const inSchemaShape = (content: string) => {
  try {
    const value: unknown = JSON.parse(content);
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { colour?: unknown }).colour === 'string'
    );
  } catch {
    return false;
  }
};

/** Only the provider refusing the request says the model lacks it; a refusal by genki itself settles nothing. */
const refusedRequest = (error: unknown) =>
  error instanceof ModelError && error.code === 'bad_request' && error.provider !== undefined;

/** A refusal counts as lacking only when the same model answers a plain request. */
const refused = async (port: ModelPort, error: unknown, calls: number): Promise<CheckOutcome> => {
  if (!refusedRequest(error)) return { calls };
  try {
    const plain = await port.chat(streamCheck);
    return { has: false, usage: plain.usage, calls: calls + 1 };
  } catch {
    return { calls: calls + 1 };
  }
};

const answered = async (
  port: ModelPort,
  request: ChatRequest,
  passes: (result: ChatResult) => boolean | undefined,
): Promise<CheckOutcome> => {
  try {
    const result = await port.chat(request);
    if (result.finishReason === 'length' || result.finishReason === 'content_filter')
      return { usage: result.usage, calls: 1 };
    const has = passes(result);
    return { ...(has === undefined ? {} : { has }), usage: result.usage, calls: 1 };
  } catch (error) {
    return refused(port, error, 1);
  }
};

const streamed = async (port: ModelPort): Promise<CheckOutcome> => {
  try {
    let done: ChatResult | undefined;
    for await (const chunk of port.chatStream(streamCheck))
      if (chunk.kind === 'done') done = chunk.result;
    return done ? { has: true, usage: done.usage, calls: 1 } : { calls: 1 };
  } catch (error) {
    return refused(port, error, 1);
  }
};

/** An outcome without `has` settled nothing; a tool left uncalled proves nothing. */
export const checkCapability = (port: ModelPort, capability: Capability): Promise<CheckOutcome> => {
  if (capability === 'json-schema')
    return answered(port, jsonSchemaCheck, (r) => inSchemaShape(r.content));
  if (capability === 'tools')
    return answered(port, toolsCheck, (r) =>
      r.toolCalls.some((c) => c.name === 'record_answer') ? true : undefined,
    );
  if (capability === 'stream') return streamed(port);
  return Promise.resolve({ calls: 0 });
};

const capabilityNames: Readonly<Record<string, Capability>> = {
  stream: 'stream',
  streaming: 'stream',
  native_streaming: 'stream',
  tools: 'tools',
  tool_calls: 'tools',
  tool_use: 'tools',
  function_calling: 'tools',
  json_schema: 'json-schema',
  structured_outputs: 'json-schema',
  response_schema: 'json-schema',
  reasoning: 'reasoning',
  reasoning_effort: 'reasoning',
  thinking: 'reasoning',
};

const supportsPrefix = 'supports_';

const capabilityNamed = (name: string) => {
  const key = name.toLowerCase().replaceAll('-', '_');
  return capabilityNames[key.startsWith(supportsPrefix) ? key.slice(supportsPrefix.length) : key];
};

const namesIn = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).flatMap(([k, v]) => (v === true ? [k] : []));
  return [];
};

const flags = (value: unknown) =>
  typeof value === 'object' && value !== null
    ? namesIn(value).filter((k) => k.startsWith(supportsPrefix))
    : [];

/** What a model entry in a /models listing says the model can do, in the shapes providers use. */
export const listedCapabilities = (entry: unknown): Capability[] => {
  if (typeof entry !== 'object' || entry === null) return [];
  const e = entry as Record<string, unknown>;
  const names = new Set(
    [
      ...namesIn(e.capabilities),
      ...namesIn(e.supported_parameters),
      ...flags(e),
      ...flags(e.model_info),
    ].flatMap((n) => {
      const found = capabilityNamed(n);
      return found ? [found] : [];
    }),
  );
  return capabilities.filter((c) => names.has(c));
};
