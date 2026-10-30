import { createHash } from 'node:crypto';
import {
  answerOf,
  fieldInput,
  noAnswerOf,
  sourcesOf,
  type SourceRecord,
} from '@genai/adapter-openai';
import {
  textPart,
  type Event,
  type InputField,
  type Part,
  type Principal,
  type Usage,
} from '@genai/contracts';
import {
  toCapabilities,
  validateDefinition,
  validateYaml,
  type CompiledCapability,
  type PluginSchemas,
} from '@genai/definitions';
import type { UsageSummary } from '@genai/eval';
import { assistantCapabilityPrefix } from '@genai/jobs';
import type { Capability as KernelCapability, CapabilityRegistry, Kernel } from '@genai/kernel';
import { blobPart, type BlobStore } from '@genai/port-blob';
import { residencies, type Residency } from '@genai/port-model';
import { parse as parseYaml } from 'yaml';
import { completeService } from './definition-completion.js';
import { failureFromError } from './failures.js';
import { strategyCatalogue } from './strategy-catalogue.js';
import { withFieldOptions, type FacetCount, type FacetSource } from './input-options.js';

export interface ModelPrice {
  inputPerThousand: number;
  outputPerThousand: number;
}

export const priced = (usage: Usage, price: ModelPrice | undefined) =>
  usage.costMicroNok ??
  (price
    ? Math.round(
        (((usage.inputTokens ?? 0) / 1000) * price.inputPerThousand +
          ((usage.outputTokens ?? 0) / 1000) * price.outputPerThousand) *
          1_000_000,
      )
    : 0);

export const serviceOrigin = 'service';
export const draftOrigins = ['builder', 'playground', 'skill-test', 'assistant'] as const;
export type DraftOrigin = (typeof draftOrigins)[number];
export type RunOrigin = DraftOrigin | typeof serviceOrigin;

const draftPrefix = 'platform/draft/';

/** The platform's eval run: its task runs a test, so it counts as testing, as its cases do. */
export const evalCapabilityId = 'platform/eval';

export const originOf = (capabilityId: string): RunOrigin => {
  if (capabilityId.startsWith(assistantCapabilityPrefix)) return 'assistant';
  if (capabilityId === evalCapabilityId) return 'builder';
  if (!capabilityId.startsWith(draftPrefix)) return serviceOrigin;
  const segment = capabilityId.slice(draftPrefix.length).split('/')[0];
  return draftOrigins.find((o) => o === segment) ?? 'builder';
};

export type DraftInputPart = { kind: 'text'; text: string } | { kind: 'file'; blob: string };

export interface DraftRunInput {
  principal: Principal;
  tenant: string;
  definition: unknown;
  files?: Record<string, string>;
  parts: DraftInputPart[];
  origin: DraftOrigin;
  input?: Record<string, unknown>;
  chargeTo?: string;
  history?: { role: 'user' | 'assistant'; text: string }[];
  data?: Record<string, unknown>;
  budget?: Usage;
  version?: number;
  variant?: string;
  onEvent?: (event: Event) => void | Promise<void>;
}

export interface DraftModelUsage {
  model: string;
  kind?: string;
  inputTokens: number;
  outputTokens: number;
  costMicroNok: number;
}

export const usageByModel = (
  events: Event[],
  prices: Record<string, ModelPrice | undefined>,
): DraftModelUsage[] => {
  const byModel = new Map<string, DraftModelUsage>();
  for (const event of events) {
    if (event.type !== 'kernel.usage') continue;
    const data = event.data as { usage?: Usage; model?: { id?: string; kind?: string } };
    if (!data.usage) continue;
    const model = data.model?.id ?? 'ukjent';
    const seen = byModel.get(model) ?? {
      model,
      ...(data.model?.kind ? { kind: data.model.kind } : {}),
      inputTokens: 0,
      outputTokens: 0,
      costMicroNok: 0,
    };
    byModel.set(model, {
      ...seen,
      inputTokens: seen.inputTokens + (data.usage.inputTokens ?? 0),
      outputTokens: seen.outputTokens + (data.usage.outputTokens ?? 0),
      costMicroNok: seen.costMicroNok + priced(data.usage, prices[model]),
    });
  }
  return [...byModel.values()];
};

/** What the models of one task used, with no cost when a model has no price. */
export const usageSummaryOf = (
  events: Event[],
  prices: Record<string, ModelPrice | undefined>,
): UsageSummary => {
  const byModel = usageByModel(events, prices);
  return {
    inputTokens: byModel.reduce((n, m) => n + m.inputTokens, 0),
    outputTokens: byModel.reduce((n, m) => n + m.outputTokens, 0),
    costMicroNok: byModel.some(
      (m) => !prices[m.model] && m.costMicroNok === 0 && m.inputTokens + m.outputTokens > 0,
    )
      ? null
      : byModel.reduce((n, m) => n + m.costMicroNok, 0),
  };
};

export interface DraftRunSuccess {
  ok: true;
  task: string;
  origin: DraftOrigin;
  answer: string;
  noAnswer: boolean;
  parts: Part[];
  sources: SourceRecord[];
  notes: string[];
  timing: { startedAt: string; endedAt: string; durationMs: number };
  usage: { inputTokens: number; outputTokens: number; byModel: DraftModelUsage[] };
  costMicroNok: number;
  costNok: number;
  dataLocation: Residency | null;
}

export interface DraftRunFailure {
  ok: false;
  status: 400 | 403 | 422 | 502;
  errors: { path: string; message: string }[];
  task?: string;
  code?: string;
  step?: string;
}

export type DraftRunOutcome = DraftRunSuccess | DraftRunFailure;

export interface ServiceInvocation {
  principal: Principal;
  tenant: string;
  capability: string;
  primaryModel?: string;
  maxOutputTokens?: number;
  data: Record<string, unknown>;
  parts: DraftInputPart[];
}

export type ServiceRunSuccess = Omit<DraftRunSuccess, 'origin'>;
export type ServiceRunOutcome = ServiceRunSuccess | DraftRunFailure;

export interface DraftDecoration {
  compiled: CompiledCapability;
  definition: unknown;
  origin: RunOrigin;
}

export type CapabilityDecorator = (
  capability: KernelCapability,
  context: DraftDecoration,
) => Promise<KernelCapability>;

export type DraftTarget = Pick<
  DraftRunInput,
  'principal' | 'tenant' | 'definition' | 'files' | 'origin' | 'chargeTo' | 'version' | 'variant'
>;

/** A draft or version registered as a capability until released, for a run of many tasks. */
export interface PreparedDraft {
  ok: true;
  capability: string;
  release(): void;
}

export interface DraftRunner {
  run(input: DraftRunInput): Promise<DraftRunOutcome>;
  prepare(input: DraftTarget): Promise<PreparedDraft | DraftRunFailure>;
  invoke(input: ServiceInvocation): Promise<ServiceRunOutcome>;
  inputFields(principal: Principal, tenant: string, definition: unknown): Promise<InputField[]>;
}

export type FieldOptionsLookup = (
  principal: Principal,
  tenant: string,
  from: FacetSource,
) => Promise<FacetCount[] | undefined>;

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const declaredFields = (definition: unknown): InputField[] => {
  let parsed = definition;
  if (typeof definition === 'string') {
    try {
      parsed = parseYaml(definition) as unknown;
    } catch {
      return [];
    }
  }
  const fields = record(record(record(parsed).spec).input).fields;
  return Array.isArray(fields)
    ? fields.filter(
        (f): f is InputField =>
          typeof record(f).id === 'string' && typeof record(f).kind === 'string',
      )
    : [];
};

export interface DraftRunnerDeps {
  kernel: Kernel;
  registry: CapabilityRegistry;
  plugins: PluginSchemas;
  blobs: BlobStore;
  prices: Record<string, ModelPrice>;
  residencyOf(model: string): Residency | undefined;
  events(task: string, isLive?: () => boolean): AsyncIterable<Event>;
  wake?(task: string): void;
  decorate?: CapabilityDecorator;
  fieldOptions?: FieldOptionsLookup;
  now?(): Date;
}

const retrievalMime = 'application/vnd.genai.retrieval+json';
const endStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const notesOf = (parts: Part[], events: Event[]) => [
  ...events.flatMap((e) =>
    e.type === 'kernel.notice' ? strings((e.data as { warnings?: unknown })?.warnings) : [],
  ),
  ...parts.flatMap((p) =>
    p.mime === retrievalMime && p.body.kind === 'json'
      ? strings((p.body.json as { attribution?: { warnings?: unknown } })?.attribution?.warnings)
      : [],
  ),
];

const failure = (
  status: DraftRunFailure['status'],
  path: string,
  message: string,
): DraftRunFailure => ({ ok: false, status, errors: [{ path, message }] });

const isTree = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const yamlOf = (text: string): { definition: unknown } | undefined => {
  try {
    return { definition: parseYaml(text) };
  } catch {
    return undefined;
  }
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createDraftRunner = (deps: DraftRunnerDeps): DraftRunner => {
  const now = deps.now ?? (() => new Date());

  const resolved = (principal: Principal, tenant: string, fields: InputField[]) => {
    const lookup = deps.fieldOptions;
    return lookup && fields.some((f) => f.optionsFrom)
      ? withFieldOptions(fields, (from) => lookup(principal, tenant, from))
      : Promise.resolve(fields);
  };

  const inputParts = async (tenant: string, parts: DraftInputPart[]) => {
    const out: Part[] = [];
    for (const [i, part] of parts.entries()) {
      if (part.kind === 'text') {
        out.push(textPart(part.text));
        continue;
      }
      const info = await deps.blobs.head({ tenant, path: part.blob });
      if (!info) return failure(422, `parts[${i}].blob`, `no file ${part.blob}`);
      out.push(blobPart(info));
    }
    return out;
  };

  const collect = async (task: string) => {
    const events: Event[] = [];
    for await (const event of deps.events(task)) events.push(event);
    return events;
  };

  const usageOf = (events: Event[]) => usageByModel(events, deps.prices);

  const locationOf = (models: string[], primary: string | undefined): Residency | null => {
    const known = [...models, ...(primary ? [primary] : [])]
      .map((m) => deps.residencyOf(m))
      .filter((r): r is Residency => r !== undefined);
    if (known.length === 0) return null;
    return residencies[Math.max(...known.map((r) => residencies.indexOf(r)))] ?? null;
  };

  const invokeCapability = async (
    principal: Principal,
    tenant: string,
    capability: string,
    data: Record<string, unknown>,
    parts: Part[],
    primary: string | undefined,
    maxOutputTokens?: number,
    onEvent?: (event: Event) => void | Promise<void>,
    budget?: Usage,
  ): Promise<ServiceRunOutcome> => {
    let task: string | undefined;
    let tail: Promise<void> | undefined;
    let settled = false;
    const startedAt = now();
    try {
      const invoked = await deps.kernel.invoke(
        { ...principal, tenant },
        capability,
        { data, parts },
        maxOutputTokens === undefined
          ? budget
            ? { budget }
            : {}
          : { maxOutputTokens, budget: { outputTokens: maxOutputTokens * 2 } },
      );
      task = invoked.task;
      const id = task;
      if (onEvent)
        tail = (async () => {
          for await (const event of deps.events(id, () => !settled)) {
            await onEvent(event);
            if (
              event.type === 'kernel.task.status' &&
              endStatuses.has(String(record(event.data).status))
            )
              return;
          }
        })().catch(() => undefined);
      const result = await invoked.result.finally(() => {
        settled = true;
        deps.wake?.(id);
      });
      await tail;
      const endedAt = now();
      const events = await collect(task);
      const byModel = usageOf(events);
      const costMicroNok = byModel.reduce((sum, m) => sum + m.costMicroNok, 0);
      return {
        ok: true,
        task,
        answer: answerOf(result),
        noAnswer: noAnswerOf(result),
        parts: result,
        sources: sourcesOf(result),
        notes: notesOf(result, events),
        timing: {
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: endedAt.getTime() - startedAt.getTime(),
        },
        usage: {
          inputTokens: byModel.reduce((sum, m) => sum + m.inputTokens, 0),
          outputTokens: byModel.reduce((sum, m) => sum + m.outputTokens, 0),
          byModel,
        },
        costMicroNok,
        costNok: costMicroNok / 1_000_000,
        dataLocation: locationOf(
          byModel.map((m) => m.model),
          primary,
        ),
      };
    } catch (error) {
      settled = true;
      if (task) deps.wake?.(task);
      await tail;
      const failed = failureFromError(error);
      return {
        ...failure(502, '', failed.message),
        code: failed.code,
        ...(failed.step ? { step: failed.step } : {}),
        ...(task ? { task } : {}),
      };
    }
  };

  const catalogue = strategyCatalogue(deps.plugins.strategies);
  const completed = (definition: unknown) =>
    isTree(definition) && definition.kind === 'Service'
      ? completeService(definition, { residencyOf: deps.residencyOf, strategies: catalogue })
          .definition
      : definition;

  const compile = (input: DraftTarget) => {
    const source = typeof input.definition === 'string' ? yamlOf(input.definition) : input;
    const validated = source
      ? validateDefinition(completed(source.definition), deps.plugins)
      : validateYaml(String(input.definition), deps.plugins);
    if (!validated.ok)
      return { ok: false as const, status: 422 as const, errors: validated.errors };
    const definition = validated.definition;
    if (definition.metadata.tenant !== input.tenant)
      return failure(403, 'metadata.tenant', 'the definition belongs to another tenant');
    if (definition.kind !== 'Service') return failure(422, 'kind', 'only services can be test run');
    const variants = toCapabilities(definition, input.version ?? 1, input.files ?? {});
    const compiled =
      input.variant === undefined ? variants[0] : variants.find((v) => v.variant === input.variant);
    if (!compiled)
      return failure(
        422,
        input.variant === undefined ? 'spec.variants' : 'variant',
        input.variant === undefined ? 'no variant' : `no variant ${input.variant}`,
      );
    return { ok: true as const, definition, compiled };
  };

  const register = async (
    input: DraftTarget,
    definition: unknown,
    compiled: CompiledCapability,
  ): Promise<PreparedDraft | DraftRunFailure> => {
    const id = `${draftPrefix}${input.origin}/${createHash('sha256')
      .update(
        `${input.tenant}/${(definition as { metadata: { id: string } }).metadata.id}/${Date.now()}/${Math.random()}`,
      )
      .digest('hex')
      .slice(0, 16)}`;
    const descriptor = { ...compiled.capability.descriptor, id };
    delete descriptor.availableTo;
    if (input.chargeTo) descriptor.availableTo = [input.chargeTo];
    let capability: KernelCapability = { ...compiled.capability, descriptor };
    try {
      if (deps.decorate)
        capability = await deps.decorate(capability, {
          compiled,
          definition,
          origin: input.origin,
        });
      deps.registry.replace(() => false, [capability]);
    } catch (error) {
      return failure(422, 'spec.strategy', messageOf(error));
    }
    return {
      ok: true,
      capability: id,
      release: () => deps.registry.replace((c) => c.descriptor.id === id, []),
    };
  };

  const prepare = async (input: DraftTarget): Promise<PreparedDraft | DraftRunFailure> => {
    const compiled = compile(input);
    return compiled.ok ? register(input, compiled.definition, compiled.compiled) : compiled;
  };

  const run = async (input: DraftRunInput): Promise<DraftRunOutcome> => {
    const { tenant } = input;
    const compiledDraft = compile(input);
    if (!compiledDraft.ok) return compiledDraft;
    const { definition, compiled } = compiledDraft;
    const question = input.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n');
    const declared = compiled.capability.descriptor.inputFields;
    const fields = declared && (await resolved(input.principal, tenant, declared));
    let query = question;
    let values: Record<string, unknown> = {};
    if (input.input !== undefined && fields?.length) {
      const checked = fieldInput(fields, input.input, question);
      if (!checked.ok) return { ok: false, status: 400, errors: checked.errors };
      query = checked.query;
      values = checked.values;
    } else if (
      input.input !== undefined &&
      !question.trim() &&
      input.parts.every((p) => p.kind === 'text')
    )
      return failure(400, 'query', 'Skriv et spørsmål.');
    const parts = await inputParts(
      tenant,
      query === question
        ? input.parts
        : [{ kind: 'text', text: query }, ...input.parts.filter((p) => p.kind !== 'text')],
    );
    if (!Array.isArray(parts)) return parts;
    const registered = await register(input, definition, compiled);
    if (!registered.ok) return registered;
    try {
      const primary = (compiled.capability.config as { model?: { primary?: string } }).model
        ?.primary;
      const outcome = await invokeCapability(
        input.principal,
        input.chargeTo ?? tenant,
        registered.capability,
        { ...values, query, history: input.history ?? [], ...input.data },
        query === question
          ? parts
          : parts.map((p, i) => (i === 0 ? { ...p, meta: { ...p.meta, inputFields: true } } : p)),
        primary,
        undefined,
        input.onEvent,
        input.budget,
      );
      return outcome.ok ? { ...outcome, origin: input.origin } : outcome;
    } finally {
      registered.release();
    }
  };

  const invoke = async (input: ServiceInvocation): Promise<ServiceRunOutcome> => {
    const parts = await inputParts(input.tenant, input.parts);
    if (!Array.isArray(parts)) return parts;
    return invokeCapability(
      input.principal,
      input.tenant,
      input.capability,
      input.data,
      parts,
      input.primaryModel,
      input.maxOutputTokens,
    );
  };

  const inputFields = (principal: Principal, tenant: string, definition: unknown) =>
    resolved(principal, tenant, declaredFields(definition));

  return { run, prepare, invoke, inputFields };
};
