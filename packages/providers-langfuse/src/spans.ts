import { createHash } from 'node:crypto';
import type { Event, Ref, Task, Usage } from '@genai/contracts';
import { experimentAttributes, itemAttributes, type Experiment } from './experiment.js';

export type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: AnyValue[] } };

export interface KeyValue {
  key: string;
  value: AnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status?: { code: number; message?: string };
}

type AttributeValue = string | number | boolean | string[] | undefined;

const toValue = (v: string | number | boolean | string[]): AnyValue => {
  if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
};

export const attributes = (record: Record<string, AttributeValue>): KeyValue[] =>
  Object.entries(record).flatMap(([key, v]) =>
    v === undefined ? [] : [{ key, value: toValue(v) }],
  );

const hex = (input: string) => createHash('sha256').update(input).digest('hex');
export const traceIdFor = (rootTask: string) => hex(`trace:${rootTask}`).slice(0, 32);
export const rootSpanIdFor = (task: string) => hex(`root:${task}`).slice(0, 16);
const spanIdFor = (task: string, key: string) => hex(`span:${task}:${key}`).slice(0, 16);

export const sampled = (rootTask: string, rate: number) =>
  rate >= 1 || parseInt(hex(`sample:${rootTask}`).slice(0, 8), 16) / 2 ** 32 < rate;

const nanos = (ts: string) => (BigInt(Date.parse(ts)) * 1_000_000n).toString();

const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;
const KIND_INTERNAL = 1;

interface UsageData {
  usage?: Usage;
  port?: string;
  ref?: Ref;
  model?: Ref;
}

interface ResourceData {
  port?: string;
  ref?: Ref;
}

const observationType = (port: string | undefined, ref: Ref | undefined) => {
  if (port === 'knowledge') return 'retriever';
  if (port === 'tool' || ref?.kind === 'tool') return 'tool';
  return 'span';
};

const json = (value: unknown) => {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

export interface BuildInput {
  task: Task | undefined;
  taskId: string;
  traceId: string;
  parentSpanId?: string;
  events: Event[];
  firstTs: string;
  terminal: Event | undefined;
  content: boolean;
  environment?: string;
  userId?: string;
  experiment?: Experiment;
}

const experimentOf = ({ experiment }: BuildInput) =>
  experiment ? experimentAttributes(experiment, rootSpanIdFor(experiment.rootTask)) : {};

const childSpans = (input: BuildInput, parent: string): OtlpSpan[] => {
  const { events, traceId, taskId, environment } = input;
  const spans: OtlpSpan[] = [];
  const common = { 'deployment.environment.name': environment, ...experimentOf(input) };

  events.forEach((event, index) => {
    if (event.type === 'kernel.usage') {
      const data = (event.data ?? {}) as UsageData;
      const modelId = data.model?.id ?? (data.port === 'model' ? data.ref?.id : undefined);
      const opened = events
        .slice(0, index)
        .reverse()
        .find((e) => {
          const r = (e.data ?? {}) as ResourceData;
          return (
            e.type === 'kernel.resource.used' && r.port === data.port && r.ref?.id === data.ref?.id
          );
        });
      const cost = data.usage?.costMicroNok;
      spans.push({
        traceId,
        spanId: spanIdFor(taskId, `usage:${event.seq}`),
        parentSpanId: parent,
        name: modelId ? `model ${modelId}` : `usage ${data.port ?? 'unknown'}`,
        kind: KIND_INTERNAL,
        startTimeUnixNano: nanos(opened?.ts ?? event.ts),
        endTimeUnixNano: nanos(event.ts),
        attributes: attributes({
          ...common,
          'langfuse.observation.type': 'generation',
          'gen_ai.request.model': modelId,
          'gen_ai.usage.input_tokens': data.usage?.inputTokens,
          'gen_ai.usage.output_tokens': data.usage?.outputTokens,
          'genai.port': data.port,
          'genai.requests': data.usage?.requests,
          'langfuse.observation.cost_details':
            cost === undefined ? undefined : json({ total: cost / 1_000_000 }),
        }),
      });
    } else if (event.type === 'kernel.resource.used') {
      const data = (event.data ?? {}) as ResourceData;
      if (data.port === 'model') return;
      spans.push({
        traceId,
        spanId: spanIdFor(taskId, `resource:${event.seq}`),
        parentSpanId: parent,
        name: `${data.port ?? 'port'} ${data.ref?.id ?? ''}`.trim(),
        kind: KIND_INTERNAL,
        startTimeUnixNano: nanos(event.ts),
        endTimeUnixNano: nanos(event.ts),
        attributes: attributes({
          ...common,
          'langfuse.observation.type': observationType(data.port, data.ref),
          'genai.port': data.port,
          'genai.resource.kind': data.ref?.kind,
          'genai.resource.id': data.ref?.id,
        }),
      });
    }
  });

  const groups = new Map<
    string,
    { parent?: string; start: string; end: string; types: Set<string> }
  >();
  for (const event of events) {
    if (!event.span) continue;
    const group = groups.get(event.span.id);
    if (group) {
      group.end = event.ts;
      group.types.add(event.type);
    } else {
      groups.set(event.span.id, {
        ...(event.span.parent ? { parent: event.span.parent } : {}),
        start: event.ts,
        end: event.ts,
        types: new Set([event.type]),
      });
    }
  }
  for (const [id, group] of groups) {
    spans.push({
      traceId,
      spanId: spanIdFor(taskId, `step:${id}`),
      parentSpanId:
        group.parent && groups.has(group.parent)
          ? spanIdFor(taskId, `step:${group.parent}`)
          : parent,
      name: id,
      kind: KIND_INTERNAL,
      startTimeUnixNano: nanos(group.start),
      endTimeUnixNano: nanos(group.end),
      attributes: attributes({
        ...common,
        'langfuse.observation.type': 'span',
        'genai.event_types': [...group.types],
      }),
    });
  }
  return spans;
};

const rootSpan = (input: BuildInput, terminal: Event): OtlpSpan => {
  const { task, taskId, events, content } = input;
  const status = ((terminal.data ?? {}) as { status?: string }).status;
  const error = events.find((e) => e.type === 'kernel.error' && e.audience === 'audit')?.data as
    { code?: string; message?: string } | undefined;
  const name = task?.service.capability.id ?? 'task';
  const inputEvent = events.find((e) => e.type === 'kernel.task.input');
  const resultEvent = events.find((e) => e.type === 'kernel.result');
  const statusMessage = error
    ? content && error.message
      ? `${error.code}: ${error.message}`
      : error.code
    : undefined;

  return {
    traceId: input.traceId,
    spanId: rootSpanIdFor(taskId),
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    name,
    kind: KIND_INTERNAL,
    startTimeUnixNano: nanos(input.firstTs),
    endTimeUnixNano: nanos(terminal.ts),
    attributes: attributes({
      'langfuse.trace.name': input.parentSpanId ? undefined : name,
      'langfuse.observation.type': 'agent',
      'langfuse.user.id': input.parentSpanId ? undefined : input.userId,
      'langfuse.session.id': input.parentSpanId ? undefined : task?.thread,
      'langfuse.trace.tags':
        input.parentSpanId || !task ? undefined : [`tenant:${task.tenant}`, `service:${name}`],
      version: task?.service.capability.version,
      environment: input.environment,
      'deployment.environment.name': input.environment,
      'genai.task.id': taskId,
      'genai.task.status': status,
      'genai.tenant': task?.tenant,
      'genai.owner': task?.owner,
      'genai.service.id': task?.service.capability.id,
      'genai.service.version': task?.service.capability.version,
      'genai.strategy.id': task?.service.strategy.id,
      'genai.strategy.version': task?.service.strategy.version,
      'genai.config_hash': task?.service.configHash,
      'genai.model.deployments': task?.service.models?.map((m) => `${m.endpoint}/${m.deployment}`),
      'genai.index.generations': task?.service.indexes?.map(
        (i) =>
          `${i.dataset}${i.generation ? `@${i.generation}` : ''}${i.collections?.length ? ` (${i.collections.join(', ')})` : ''}`,
      ),
      'genai.error.code': error?.code,
      'langfuse.observation.input':
        content && inputEvent ? json((inputEvent.data as { input?: unknown }).input) : undefined,
      'langfuse.observation.output': content && resultEvent ? json(resultEvent.data) : undefined,
      ...experimentOf(input),
      ...(input.experiment?.rootTask === taskId ? itemAttributes(input.experiment) : {}),
    }),
    status: {
      code: status === 'failed' ? STATUS_ERROR : status === 'completed' ? STATUS_OK : STATUS_UNSET,
      ...(statusMessage ? { message: statusMessage } : {}),
    },
  };
};

export const buildSpans = (input: BuildInput): OtlpSpan[] => {
  const root = rootSpanIdFor(input.taskId);
  const children = childSpans(input, root);
  return input.terminal ? [rootSpan(input, input.terminal), ...children] : children;
};
