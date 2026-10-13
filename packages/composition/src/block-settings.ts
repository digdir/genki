import type { Ref } from '@genai/contracts';
import {
  flowUsesOf,
  refName,
  serviceDefinition,
  toolRef,
  type ServiceDefinition,
} from '@genai/definitions';
import { KernelError, type Capability, type InvocationContext, type Strategy } from '@genai/kernel';
import { ToolError, type ToolPort } from '@genai/port-tools';
import type { ConfigEntryStore } from './config-store.js';

export const adoptionKind = 'block-adoption';
export const runtimeBlocksKey = 'buildingBlocks';

export const blockKey = (kind: string, id: string) => `${kind}:${id}`;

export interface RuntimeBlock {
  key: string;
  name: string;
  path: string;
  tool?: string;
}

export interface RuntimeBlocks {
  tenant: string;
  blocks: RuntimeBlock[];
}

export interface BlockTexts {
  disabled(name: string): string;
  toolTimedOut(seconds: number): string;
}

export type ReferenceKind = 'model' | 'dataset' | 'tool' | 'skill' | 'guardrail' | 'step_flow';

export interface BlockReference {
  kind: ReferenceKind;
  id: string;
  ref?: string;
  version?: number;
}

interface WalkStep {
  block?: string;
  repeat?: { steps: unknown[] };
  forEach?: { steps: unknown[] };
  cases?: { steps: unknown[] }[];
  else?: unknown[];
}

export const stepBlocks = (steps: unknown[]): string[] =>
  (steps as WalkStep[]).flatMap((step) => [
    ...(step.block ? [step.block] : []),
    ...[
      step.repeat?.steps,
      step.forEach?.steps,
      ...(step.cases ?? []).map((k) => k.steps),
      step.else,
    ]
      .filter((nested): nested is unknown[] => Array.isArray(nested))
      .flatMap(stepBlocks),
  ]);

const versionOf = (ref: string) => {
  const major = Number(ref.slice(ref.lastIndexOf('@') + 1).split('.')[0]);
  return Number.isInteger(major) ? major : undefined;
};

export const versionedReference = (kind: ReferenceKind, ref: string): BlockReference => {
  const version = versionOf(ref);
  return { kind, id: refName(ref), ref, ...(version === undefined ? {} : { version }) };
};

export const serviceReferences = (definition: ServiceDefinition): BlockReference[] => {
  const spec = serviceDefinition.safeParse(definition).data?.spec ?? definition.spec;
  const models = [
    spec.model.primary,
    spec.model.fallback,
    ...Object.values(spec.model.roles ?? {}),
  ].filter((m): m is string => typeof m === 'string');
  const custom = spec.guardrails['custom-rules'];
  const flows = [...new Set(flowUsesOf(spec).map((u) => u.flow))];
  return [
    ...models.map((id) => ({ kind: 'model' as const, id })),
    ...spec.knowledge.datasets.map((d) => ({ kind: 'dataset' as const, id: d.dataset })),
    ...spec.tools.map((t) => versionedReference('tool', toolRef(t))),
    ...spec.skills.map((s) => versionedReference('skill', s)),
    ...Object.keys(spec.guardrails)
      .filter((g) => g !== 'custom-rules')
      .map((id) => ({ kind: 'guardrail' as const, id })),
    ...(Array.isArray(custom)
      ? custom
          .filter((r): r is string => typeof r === 'string')
          .map((r) => ({
            kind: 'guardrail' as const,
            id: `custom-rules/${r.slice(r.indexOf('/') + 1)}`,
          }))
      : []),
    ...flows.map((flow) => versionedReference('step_flow', flow)),
  ];
};

export interface RuntimeBlockLookups {
  flowSteps(tenant: string, flow: BlockReference): Promise<unknown[]>;
  resolveDataset(id: string): string;
  datasetEndpoint(id: string): string | undefined;
  sharedTools(tenant: string): Promise<Map<string, string>>;
}

export const runtimeBlocksOf = async (
  definition: ServiceDefinition,
  lookups: RuntimeBlockLookups,
): Promise<RuntimeBlock[]> => {
  const tenant = definition.metadata.tenant;
  const refs = serviceReferences(definition);
  for (const flow of refs.filter((r) => r.kind === 'step_flow'))
    for (const block of stepBlocks(await lookups.flowSteps(tenant, flow)))
      refs.push({ kind: 'step_flow', id: refName(block), ref: block });
  const shared = refs.some((r) => r.kind === 'tool')
    ? await lookups.sharedTools(tenant)
    : new Map<string, string>();
  const out = new Map<string, RuntimeBlock>();
  const add = (kind: string, id: string, path: string, tool?: string) => {
    const key = blockKey(kind, id);
    const at = tool ? `${key}|${tool}` : key;
    if (!out.has(at)) out.set(at, { key, name: id, path, ...(tool ? { tool } : {}) });
  };
  for (const ref of refs) {
    if (ref.kind === 'model') add('model', ref.id, 'spec.model');
    if (ref.kind === 'dataset') {
      add('dataset', lookups.resolveDataset(ref.id), 'spec.knowledge.datasets');
      add('dataset', `${tenant}/${ref.id}`, 'spec.knowledge.datasets');
      const endpoint = lookups.datasetEndpoint(ref.id);
      if (endpoint) add('search_engine', endpoint, 'spec.knowledge.datasets');
    }
    if (ref.kind === 'tool') {
      const tool = ref.ref ?? ref.id;
      const dot = ref.id.indexOf('.');
      if (dot > 0) add('tool', ref.id.slice(0, dot), 'spec.tools', tool);
      const owner = shared.get(ref.id);
      if (owner) add('shared_service', owner, 'spec.tools');
    }
    if (ref.kind === 'skill') add('skill', ref.id, 'spec.skills');
    if (ref.kind === 'guardrail') add('guardrail', ref.id, 'spec.guardrails');
    if (ref.kind === 'step_flow') {
      add('step_flow', ref.id, 'spec.strategy.config.flow');
      if (ref.ref) add('step_flow', ref.ref, 'spec.strategy.config.flow');
    }
  }
  return [...out.values()];
};

export const attachRuntimeBlocks = (
  capability: Capability,
  tenant: string,
  blocks: RuntimeBlock[],
): Capability => {
  if (blocks.length === 0) return capability;
  const attached: RuntimeBlocks = { tenant, blocks };
  return {
    ...capability,
    config: { ...(capability.config as Record<string, unknown>), [runtimeBlocksKey]: attached },
  };
};

export const blockSettings = async (
  configEntries: Pick<ConfigEntryStore, 'latest'>,
  tenant: string,
) =>
  new Map(
    (await configEntries.latest({ kind: adoptionKind, scope: tenant }))
      .filter((e) => !e.deleted)
      .map((e) => [e.id, (e.spec as { settings?: Record<string, unknown> }).settings ?? {}]),
  );

const withTimeout = (port: ToolPort, seconds: number, texts: BlockTexts): ToolPort => ({
  definition: () => port.definition(),
  call: (input) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ToolError('failed', texts.toolTimedOut(seconds))),
        seconds * 1000,
      );
      port
        .call(input)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    }),
});

export const withBlockSettings = <C>(
  configEntries: Pick<ConfigEntryStore, 'latest'>,
  inner: Strategy<C>,
  texts: BlockTexts,
): Strategy<C> => {
  const prepare = async (ctx: InvocationContext, config: C) => {
    const { [runtimeBlocksKey]: attached, ...rest } = (config ?? {}) as Record<string, unknown>;
    const runtime = attached as RuntimeBlocks | undefined;
    if (!runtime) return { ctx, config };
    const settings = await blockSettings(configEntries, runtime.tenant);
    const off = runtime.blocks.find((b) => settings.get(b.key)?.enabled === false);
    if (off) throw new KernelError('forbidden', texts.disabled(off.name));
    const timeouts = new Map(
      runtime.blocks.flatMap((b) => {
        const seconds = settings.get(b.key)?.timeoutSeconds;
        return b.tool && typeof seconds === 'number' ? [[b.tool, seconds] as const] : [];
      }),
    );
    const scoped: InvocationContext =
      timeouts.size === 0
        ? ctx
        : {
            ...ctx,
            use: async <P>(port: string, ref: Ref) => {
              const opened = await ctx.use<P>(port, ref);
              const seconds = port === 'tools' ? timeouts.get(ref.id) : undefined;
              return (seconds ? withTimeout(opened as ToolPort, seconds, texts) : opened) as P;
            },
          };
    return { ctx: scoped, config: rest as C };
  };
  const resume = inner.resume;
  return {
    ...inner,
    run: async function* (ctx, input, config) {
      const prepared = await prepare(ctx, config);
      yield* inner.run(prepared.ctx, input, prepared.config);
    },
    ...(resume
      ? {
          resume: async function* (ctx, checkpoint, response, config) {
            const prepared = await prepare(ctx, config);
            yield* resume(prepared.ctx, checkpoint, response, prepared.config);
          },
        }
      : {}),
  };
};
