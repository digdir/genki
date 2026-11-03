import { isDeepStrictEqual } from 'node:util';
import {
  decideShape,
  embedShape,
  rerankShape,
  type OperationShape,
  type Shape,
} from '@genai/kernel';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { rootsOf } from './mapping.js';
import { DescriptorError, fieldNames, shapeOf } from './shape.js';

export const descriptorIdPattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@[1-9]\d*$/;

export const descriptorStatuses = ['review', 'described', 'typed'] as const;
export type DescriptorStatus = (typeof descriptorStatuses)[number];

/** The operations Genki has its own types for; a typed descriptor must declare exactly their shapes. */
export const typedShapes: Readonly<Record<string, OperationShape>> = {
  embed: embedShape,
  decide: decideShape,
  rerank: rerankShape,
};

const authHeaderNames = new Set(['authorization', 'api-key', 'x-api-key', 'cookie']);
const keptOutPath =
  /\/(?:realtime|batch(?:es)?|files|uploads|vector_stores|assistants|threads|conversations|containers|fine_tuning|agents)(?:\/|$)|\/responses\/\{/i;
const keptOutFields = new Set([
  'store',
  'background',
  'previous_response_id',
  'conversation',
  'file_id',
  'file_ids',
  'vector_store_ids',
  'assistant_id',
  'thread_id',
  'image_url',
  'file_url',
  'audio_url',
  'url',
]);
const urlLike = /[a-z][a-z0-9+.-]*:\/\//i;

const literal = z.string().max(200);

export const descriptorFile = z.strictObject({
  id: z.string().regex(descriptorIdPattern),
  operation: z.string().regex(/^[a-z][a-z0-9-]*$/),
  status: z.enum(descriptorStatuses),
  summary: z.string().min(1).max(500),
  api: z.strictObject({
    protocol: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    version: z.string().min(1).max(64),
    query: z.record(z.string().regex(/^[a-z0-9_-]+$/i), literal).default({}),
    headers: z.record(z.string().regex(/^[a-z0-9-]+$/i), literal).default({}),
  }),
  auth: z.strictObject({ keyHeader: z.string().regex(/^[a-z0-9-]+$/i) }).default({
    keyHeader: 'authorization',
  }),
  request: z.strictObject({
    method: z.enum(['POST', 'PUT']),
    path: z.string().regex(/^\/[A-Za-z0-9/_.{}-]*$/),
    body: z.unknown(),
  }),
  input: z.unknown(),
  output: z.unknown(),
  wire: z.strictObject({ request: z.unknown(), response: z.unknown() }),
  result: z.unknown(),
  usage: z.record(
    z.enum(['inputTokens', 'outputTokens', 'cachedInputTokens', 'requests']),
    z.unknown(),
  ),
  stream: z.union([
    z.literal('none'),
    z.strictObject({
      events: z.record(
        z.string().regex(/^[a-z0-9._-]+$/i),
        z.strictObject({
          shape: z.unknown(),
          delta: z.string().startsWith('$').optional(),
          done: z.literal(true).optional(),
        }),
      ),
    }),
  ]),
});

export interface StreamEvent {
  shape: Shape;
  delta?: string;
  done?: true;
}

export interface Descriptor {
  id: string;
  operation: string;
  status: DescriptorStatus;
  summary: string;
  api: {
    protocol: string;
    version: string;
    query: Record<string, string>;
    headers: Record<string, string>;
  };
  auth: { keyHeader: string };
  request: { method: 'POST' | 'PUT'; path: string; body: unknown };
  input: Shape;
  output: Shape;
  wire: { request: Shape; response: Shape };
  result: unknown;
  usage: Record<string, unknown>;
  stream: 'none' | { events: Record<string, StreamEvent> };
}

const strings = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
};

const checkRoots = (template: unknown, allowed: string[], at: string) => {
  const unknown = rootsOf(template).filter((r) => !allowed.includes(r));
  if (unknown.length > 0)
    throw new DescriptorError(`${at}: reads $${unknown.join(', $')}, which is not available here`);
};

/** Validates a parsed descriptor and turns its shapes into the kernel's closed shapes. */
export const toDescriptor = (value: unknown): Descriptor => {
  const parsed = descriptorFile.safeParse(value);
  if (!parsed.success)
    throw new DescriptorError(
      parsed.error.issues
        .map((i) => `${i.path.join('.') || 'descriptor'}: ${i.message}`)
        .join('; '),
    );
  const d = parsed.data;
  const at = d.id;
  if (strings({ ...d, summary: '' }).some((s) => urlLike.test(s)))
    throw new DescriptorError(
      `${at}: a descriptor names no URL; the endpoint comes from the catalogue`,
    );
  for (const name of Object.keys(d.api.headers))
    if (authHeaderNames.has(name.toLowerCase()))
      throw new DescriptorError(`${at}: api.headers.${name}: credentials come from the endpoint`);
  if (keptOutPath.test(d.request.path) || d.request.path.includes('..'))
    throw new DescriptorError(`${at}: request.path ${d.request.path} is kept out of descriptors`);
  const placeholders = [...d.request.path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  if (placeholders.some((p) => p !== 'deployment'))
    throw new DescriptorError(`${at}: request.path may only hold {deployment}`);
  const wire = {
    request: shapeOf(d.wire.request, `${at}: wire.request`),
    response: shapeOf(d.wire.response, `${at}: wire.response`),
  };
  const kept = fieldNames(wire.request).filter((f) => keptOutFields.has(f));
  if (kept.length > 0)
    throw new DescriptorError(`${at}: wire.request may not carry ${kept.join(', ')}`);
  const stream: Descriptor['stream'] =
    d.stream === 'none'
      ? 'none'
      : {
          events: Object.fromEntries(
            Object.entries(d.stream.events).map(([name, e]) => [
              name,
              {
                shape: shapeOf(e.shape, `${at}: stream.events.${name}`),
                ...(e.delta ? { delta: e.delta } : {}),
                ...(e.done ? { done: true as const } : {}),
              },
            ]),
          ),
        };
  checkRoots(d.request.body, ['input', 'deployment', 'item'], `${at}: request.body`);
  checkRoots(d.usage, ['response', 'item'], `${at}: usage`);
  checkRoots(
    d.result,
    ['response', 'input', 'deployment', 'usage', 'dropped', 'item'],
    `${at}: result`,
  );
  const descriptor: Descriptor = {
    id: d.id,
    operation: d.operation,
    status: d.status,
    summary: d.summary,
    api: d.api,
    auth: d.auth,
    request: d.request,
    input: shapeOf(d.input, `${at}: input`),
    output: shapeOf(d.output, `${at}: output`),
    wire,
    result: d.result,
    usage: d.usage,
    stream,
  };
  if (descriptor.status === 'typed') {
    const typed = typedShapes[descriptor.operation];
    if (!typed)
      throw new DescriptorError(`${at}: Genki has no own types for ${descriptor.operation}`);
    if (
      !isDeepStrictEqual(typed.request, descriptor.input) ||
      !isDeepStrictEqual(typed.result, descriptor.output)
    )
      throw new DescriptorError(
        `${at}: a typed descriptor declares the input and output shapes of ${descriptor.operation}`,
      );
  }
  return descriptor;
};

export const parseDescriptor = (text: string): Descriptor => {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    throw new DescriptorError(`not valid YAML: ${(error as Error).message}`);
  }
  return toDescriptor(value);
};
