import { toCapabilities, type CompiledCapability } from './compile.js';
import { checkFlowSettings } from './flow-settings.js';
import { checkPromptFiles, type PromptFiles } from './prompts.js';
import {
  flowUsesOf,
  publicNamesOf,
  refName,
  serviceDefinition,
  toolRef,
  type Definition,
  type FlowStep,
  type ServiceDefinition,
  type SkillDefinition,
  type StepFlowDefinition,
} from './schema.js';
import {
  strategyKey,
  validateDefinition,
  type PluginSchemas,
  type ValidationError,
} from './validate.js';

export interface PublishedVersion<D extends Definition = Definition> {
  version: number;
  definition: D;
  publishedBy: string;
  publishedAt: string;
  reason: string;
  files: PromptFiles;
}

export interface InvalidStoredDefinition {
  kind: Definition['kind'];
  tenant: string;
  id: string;
  version: number;
  errors: ValidationError[];
}

export type OnInvalidStored = (found: InvalidStoredDefinition) => void;

const issuePath = (path: PropertyKey[]) =>
  path
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`))
    .join('')
    .replace(/^\./, '');

export const storedServiceProblems = (
  stored: PublishedVersion,
  plugins: Pick<PluginSchemas, 'strategies'>,
): ValidationError[] => {
  const raw = stored.definition as unknown as { metadata?: Record<string, unknown> };
  const metadata = { ...raw.metadata };
  delete metadata.version;
  const parsed = serviceDefinition.safeParse({ ...raw, metadata });
  if (!parsed.success)
    return parsed.error.issues.map((i) => ({ path: issuePath(i.path), message: i.message }));
  const { spec } = parsed.data;
  const strategies = [
    { strategy: spec.strategy, base: ['spec', 'strategy'] as PropertyKey[] },
    ...spec.variants.flatMap((v, i) =>
      typeof v !== 'string' && v.strategy
        ? [{ strategy: v.strategy, base: ['spec', 'variants', i, 'strategy'] as PropertyKey[] }]
        : [],
    ),
  ];
  return strategies.flatMap(({ strategy, base }) => {
    const schema = plugins.strategies.get(strategyKey(strategy.id, strategy.version));
    if (!schema)
      return [
        {
          path: issuePath(base),
          message: `unknown strategy ${strategyKey(strategy.id, strategy.version)}`,
        },
      ];
    const config = schema.safeParse(strategy.config);
    return config.success
      ? []
      : config.error.issues.map((i) => ({
          path: issuePath([...base, 'config', ...i.path]),
          message: i.message,
        }));
  });
};

export const capabilitiesOrNone = (stored: PublishedVersion): CompiledCapability[] => {
  try {
    return toCapabilities(stored.definition as ServiceDefinition, stored.version, stored.files);
  } catch {
    return [];
  }
};

export const compileStoredServices = (
  latest: PublishedVersion[],
  plugins: Pick<PluginSchemas, 'strategies'>,
  onInvalid?: OnInvalidStored,
): CompiledCapability[] =>
  latest.flatMap((stored) => {
    const { metadata } = stored.definition;
    const report = (errors: ValidationError[]) => {
      onInvalid?.({
        kind: 'Service',
        tenant: metadata.tenant,
        id: metadata.id,
        version: stored.version,
        errors,
      });
      return [];
    };
    const problems = storedServiceProblems(stored, plugins);
    if (problems.length > 0) return report(problems);
    try {
      return toCapabilities(stored.definition as ServiceDefinition, stored.version, stored.files);
    } catch (error) {
      return report([
        { path: '', message: error instanceof Error ? error.message : String(error) },
      ]);
    }
  });

export type PublishResult =
  | { ok: true; version: PublishedVersion; capabilities: CompiledCapability[] }
  | { ok: false; errors: ValidationError[] };

export interface DefinitionStore {
  publish(
    input: unknown,
    actor: string,
    reason: string,
    files?: PromptFiles,
  ): Promise<PublishResult>;
  get(
    kind: Definition['kind'],
    tenant: string,
    id: string,
    version?: number,
  ): Promise<PublishedVersion | undefined>;
  versions(kind: Definition['kind'], tenant: string, id: string): Promise<PublishedVersion[]>;
  list(tenant: string): Promise<{ kind: Definition['kind']; id: string }[]>;
  resolve(name: string, version?: number): Promise<CompiledCapability | undefined>;
  capabilities(onInvalid?: OnInvalidStored): Promise<CompiledCapability[]>;
}

export type SkillFinder = (
  tenant: string,
  id: string,
  version: number,
) => SkillDefinition | undefined | Promise<SkillDefinition | undefined>;

export const checkServiceSkills = async (
  definition: ServiceDefinition,
  find: SkillFinder,
): Promise<ValidationError[]> => {
  const tools = new Set(definition.spec.tools.map(toolRef));
  const errors: ValidationError[] = [];
  for (const [i, ref] of definition.spec.skills.entries()) {
    const at = ref.lastIndexOf('@');
    const version = Number(ref.slice(at + 1));
    const skill = Number.isInteger(version)
      ? await find(definition.metadata.tenant, ref.slice(0, at), version)
      : undefined;
    if (!skill) {
      errors.push({ path: `spec.skills[${i}]`, message: `no published skill ${ref}` });
      continue;
    }
    for (const tool of skill.spec.tools.filter((t) => !tools.has(t)))
      errors.push({
        path: `spec.skills[${i}]`,
        message: `skill ${ref} uses the tool ${tool}, which the service does not have in spec.tools`,
      });
  }
  return errors;
};

export type FlowFinder = (
  tenant: string,
  id: string,
  version: number,
) => StepFlowDefinition | undefined | Promise<StepFlowDefinition | undefined>;

const toolSteps = (steps: FlowStep[]): FlowStep[] =>
  steps.flatMap((s) => [
    ...(s.block?.startsWith('tool@') ? [s] : []),
    ...toolSteps(s.repeat?.steps ?? []),
    ...toolSteps(s.forEach?.steps ?? []),
    ...(s.cases ?? []).flatMap((c) => toolSteps(c.steps)),
    ...toolSteps(s.else ?? []),
  ]);

export const checkServiceFlowTools = async (
  definition: ServiceDefinition,
  find: FlowFinder,
): Promise<ValidationError[]> => {
  const tools = new Set(definition.spec.tools.map((t) => refName(toolRef(t))));
  const flows = [...new Set(flowUsesOf(definition.spec).map((u) => u.flow))];
  const problems = await Promise.all(
    flows.map(async (flow) => {
      const at = flow.lastIndexOf('@');
      const version = Number(flow.slice(at + 1));
      const found = Number.isInteger(version)
        ? await find(definition.metadata.tenant, flow.slice(0, at), version)
        : undefined;
      if (!found) return [];
      return toolSteps(found.spec.steps).flatMap((step) => {
        const params = step.params ?? {};
        const name = `${String(params.source)}.${String(params.tool)}`;
        return tools.has(name)
          ? []
          : [
              {
                path: 'spec.tools',
                message: `step ${step.id} in ${flow} calls the tool ${name}, which the service does not have in spec.tools`,
              },
            ];
      });
    }),
  );
  return problems.flat();
};

export interface FlowSettingUse {
  flow: string;
  settings: unknown;
  path: string;
}

const configOf = (strategy: { config?: unknown }) =>
  strategy.config && typeof strategy.config === 'object'
    ? (strategy.config as Record<string, unknown>)
    : {};

export const flowSettingUsesOf = (spec: ServiceDefinition['spec']): FlowSettingUse[] => {
  const uses: FlowSettingUse[] = [];
  const service = configOf(spec.strategy);
  if (spec.strategy.id === 'step-flow' && typeof service.flow === 'string')
    uses.push({
      flow: service.flow,
      settings: service.settings,
      path: 'spec.strategy.config.settings',
    });
  spec.variants.forEach((v, i) => {
    if (typeof v === 'string') return;
    const strategy = v.strategy ?? spec.strategy;
    if (strategy.id !== 'step-flow') return;
    const own = 'flow' in v.overrides || 'settings' in v.overrides;
    if (!v.strategy && !own) return;
    const merged = { ...configOf(strategy), ...v.overrides };
    if (typeof merged.flow !== 'string') return;
    uses.push({
      flow: merged.flow,
      settings: merged.settings,
      path:
        'settings' in v.overrides
          ? `spec.variants[${i}].overrides.settings`
          : v.strategy
            ? `spec.variants[${i}].strategy.config.settings`
            : 'spec.strategy.config.settings',
    });
  });
  return uses;
};

export const checkServiceFlowSettings = async (
  definition: ServiceDefinition,
  find: FlowFinder,
): Promise<ValidationError[]> => {
  const problems = await Promise.all(
    flowSettingUsesOf(definition.spec).map(async ({ flow, settings, path }) => {
      const at = flow.lastIndexOf('@');
      const version = Number(flow.slice(at + 1));
      const found = Number.isInteger(version)
        ? await find(definition.metadata.tenant, flow.slice(0, at), version)
        : undefined;
      if (!found) return [];
      return checkFlowSettings(found.spec.settings, settings).map((p) => ({
        path: p.path ? `${path}.${p.path}` : path,
        message: `${p.message} (step flow ${flow})`,
      }));
    }),
  );
  return problems.flat();
};

const keyOf = (kind: string, tenant: string, id: string) => `${kind}:${tenant}/${id}`;

const subflows = (steps: FlowStep[]): string[] =>
  steps.flatMap((s) => [
    ...(s.subflow ? [s.subflow] : []),
    ...subflows(s.repeat?.steps ?? []),
    ...subflows(s.forEach?.steps ?? []),
    ...(s.cases ?? []).flatMap((c) => subflows(c.steps)),
    ...subflows(s.else ?? []),
  ]);

export class InMemoryDefinitionStore implements DefinitionStore {
  readonly #definitions = new Map<string, PublishedVersion[]>();

  constructor(
    private readonly plugins: PluginSchemas,
    private readonly now: () => Date = () => new Date(),
    private readonly sharedSkill?: SkillFinder,
    private readonly sharedFlow?: FlowFinder,
  ) {}

  async publish(
    input: unknown,
    actor: string,
    reason: string,
    files: PromptFiles = {},
  ): Promise<PublishResult> {
    if (reason.trim().length === 0)
      return { ok: false, errors: [{ path: '', message: 'a reason is required' }] };
    const validated = validateDefinition(input, this.plugins);
    if (!validated.ok) return validated;
    const { definition } = validated;
    const { tenant, id } = definition.metadata;
    const key = keyOf(definition.kind, tenant, id);

    const errors = [
      ...checkPromptFiles(definition, files),
      ...(definition.kind === 'Service'
        ? [
            ...this.#checkService(definition, key),
            ...(await this.#missingFlows(tenant, flowUsesOf(definition.spec))),
            ...(await checkServiceSkills(definition, (t, i, v) => this.#skill(t, i, v))),
            ...(await checkServiceFlowTools(definition, (t, i, v) => this.#flow(t, i, v))),
            ...(await checkServiceFlowSettings(definition, (t, i, v) => this.#flow(t, i, v))),
          ]
        : definition.kind === 'StepFlow'
          ? await this.#missingFlows(
              tenant,
              subflows(definition.spec.steps).map((flow) => ({ flow, path: 'spec.steps' })),
            )
          : []),
    ];
    if (errors.length > 0) return { ok: false, errors };

    const history = this.#definitions.get(key) ?? [];
    const version = (history.at(-1)?.version ?? 0) + 1;
    const stored: PublishedVersion = {
      version,
      definition: structuredClone({ ...definition, metadata: { ...definition.metadata, version } }),
      publishedBy: actor,
      publishedAt: this.now().toISOString(),
      reason,
      files: structuredClone(files),
    };
    this.#definitions.set(key, [...history, stored]);
    return {
      ok: true,
      version: structuredClone(stored),
      capabilities: definition.kind === 'Service' ? toCapabilities(definition, version, files) : [],
    };
  }

  async get(kind: Definition['kind'], tenant: string, id: string, version?: number) {
    const history = this.#definitions.get(keyOf(kind, tenant, id)) ?? [];
    const found =
      version === undefined ? history.at(-1) : history.find((v) => v.version === version);
    return found && structuredClone(found);
  }

  async versions(kind: Definition['kind'], tenant: string, id: string) {
    return structuredClone(this.#definitions.get(keyOf(kind, tenant, id)) ?? []);
  }

  async list(tenant: string) {
    return [...this.#definitions.values()]
      .flatMap((history) => history.slice(-1))
      .map((v) => v.definition)
      .filter((d) => d.metadata.tenant === tenant)
      .map((d) => ({ kind: d.kind, id: d.metadata.id }))
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  }

  async resolve(name: string, version?: number) {
    for (const history of this.#services()) {
      const chosen =
        version === undefined ? history.at(-1) : history.find((v) => v.version === version);
      if (!chosen) continue;
      const match = capabilitiesOrNone(chosen).find(
        (c) =>
          c.capability.descriptor.id === name || c.publicName === name || c.aliases.includes(name),
      );
      if (match) return match;
    }
    return undefined;
  }

  async capabilities(onInvalid?: OnInvalidStored) {
    return compileStoredServices(
      this.#services().flatMap((history) => history.slice(-1)),
      this.plugins,
      onInvalid,
    );
  }

  #services() {
    return [...this.#definitions.entries()]
      .filter(([key]) => key.startsWith('Service:'))
      .map(([, history]) => history as PublishedVersion<ServiceDefinition>[]);
  }

  async #skill(tenant: string, id: string, version: number) {
    const own = this.#definitions
      .get(keyOf('Skill', tenant, id))
      ?.find((v) => v.version === version)?.definition as SkillDefinition | undefined;
    return own ?? (await this.sharedSkill?.(tenant, id, version));
  }

  async #flow(tenant: string, id: string, version: number) {
    const own = this.#definitions
      .get(keyOf('StepFlow', tenant, id))
      ?.find((p) => p.version === version)?.definition as StepFlowDefinition | undefined;
    return own ?? (await this.sharedFlow?.(tenant, id, version));
  }

  async #missingFlows(tenant: string, uses: { flow: string; path: string }[]) {
    const errors: ValidationError[] = [];
    for (const { flow, path } of uses) {
      const at = flow.lastIndexOf('@');
      const version = Number(flow.slice(at + 1));
      const found =
        at > 0 && Number.isInteger(version)
          ? await this.#flow(tenant, flow.slice(0, at), version)
          : undefined;
      if (!found) errors.push({ path, message: `no published step flow ${flow}` });
    }
    return errors;
  }

  #checkService(definition: ServiceDefinition, key: string): ValidationError[] {
    const errors: ValidationError[] = [];
    const taken = new Map<string, string>();
    for (const [otherKey, history] of this.#definitions) {
      const latest = history.at(-1);
      if (otherKey === key || !latest || latest.definition.kind !== 'Service') continue;
      const other = latest.definition;
      for (const v of other.spec.variants) {
        const { primary, aliases } = publicNamesOf(other, v);
        for (const n of [primary, ...aliases]) taken.set(n, otherKey);
      }
    }
    definition.spec.variants.forEach((v, i) => {
      const { primary, aliases } = publicNamesOf(definition, v);
      for (const n of [primary, ...aliases]) {
        const owner = taken.get(n);
        if (owner)
          errors.push({
            path: `spec.variants[${i}]`,
            message: `public name ${n} is used by ${owner}`,
          });
      }
    });

    return errors;
  }
}
