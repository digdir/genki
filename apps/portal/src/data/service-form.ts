import {
  applySpec,
  renamed,
  type DatasetRef,
  type ExposureKey,
  type OutputKind,
  type RiskClass,
  type ServiceDefinition,
  type ServiceSpec,
  type SpecPatch,
  type ToolRef,
  type Trigger,
  type VariantSpec,
} from './service-definition';
import { strategyEntry, takesOf } from './strategies';

export type JobId =
  | 'answers'
  | 'drafts'
  | 'rewrites'
  | 'summarises'
  | 'extracts'
  | 'sorts'
  | 'prepares'
  | 'transcribes';

export const jobOf = (outputKind: string): JobId =>
  outputKind === 'fields' ? 'extracts' : outputKind === 'document' ? 'drafts' : 'answers';

export const riskClasses: RiskClass[] = ['minimal', 'limited', 'high'];
export const audienceIds = ['employees', 'agencies', 'public'] as const;
export const offeredAudiences = new Set<string>(['employees']);

const without = <T extends object>(o: T | undefined, key: string): T =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k !== key)) as T;

export const inputChoices = {
  text: ['text/plain'],
  files: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  audio: ['audio/mpeg'],
  system: ['application/json'],
} as const;

export type InputChoice = keyof typeof inputChoices;

export const inputChoiceOn = (spec: ServiceSpec, choice: InputChoice) =>
  inputChoices[choice].some((m) => spec.input.accepts.includes(m));

export const withInputChoice = (spec: ServiceSpec, choice: InputChoice): SpecPatch => {
  const mimes: readonly string[] = inputChoices[choice];
  const accepts = inputChoiceOn(spec, choice)
    ? spec.input.accepts.filter((m) => !mimes.includes(m))
    : [...spec.input.accepts, ...mimes.filter((m) => !spec.input.accepts.includes(m))];
  return { input: { ...spec.input, accepts } };
};

export const triggerDefaults = { folder: 'Innboks', queue: 'innkommende-post' };

export const schedulePresets = {
  nightly: '0 2 * * *',
  hourly: '0 * * * *',
  monday: '0 7 * * 1',
} as const;

export type SchedulePreset = keyof typeof schedulePresets;

export const presetOf = (cron: string | undefined) =>
  (Object.keys(schedulePresets) as SchedulePreset[]).find((k) => schedulePresets[k] === cron);

export const channelKeys = [
  'chatOwn',
  'api',
  'mcp',
  'openai',
  'a2a',
  'fileTrigger',
  'queue',
  'schedule',
  'batch',
] as const;

export type ChannelKey = (typeof channelKeys)[number];

export const channelGroups: [string, ChannelKey[]][] = [
  ['chat', ['chatOwn']],
  ['system', ['api', 'mcp', 'openai', 'a2a']],
  ['trigger', ['fileTrigger', 'queue', 'schedule']],
  ['batch', ['batch']],
];

const exposureOf: Partial<Record<ChannelKey, ExposureKey>> = {
  chatOwn: 'chat',
  api: 'rest',
  mcp: 'mcp',
  openai: 'openai',
  a2a: 'a2a',
};

const triggerKindOf: Partial<Record<ChannelKey, Trigger['kind']>> = {
  fileTrigger: 'document-arrives',
  queue: 'queue-message',
  schedule: 'schedule',
};

export const triggerOf = <K extends Trigger['kind']>(spec: ServiceSpec, kind: K) =>
  spec.triggers?.find((t): t is Extract<Trigger, { kind: K }> => t.kind === kind);

export const channelOn = (spec: ServiceSpec, key: ChannelKey) => {
  const exposure = exposureOf[key];
  if (exposure) return spec.exposure?.[exposure] === true;
  const kind = triggerKindOf[key];
  if (kind) return !!triggerOf(spec, kind);
  return spec.batch?.enabled === true;
};

const newTrigger = (kind: Trigger['kind']): Trigger =>
  kind === 'document-arrives'
    ? { kind, folder: triggerDefaults.folder }
    : kind === 'queue-message'
      ? { kind, queue: triggerDefaults.queue }
      : { kind, cron: schedulePresets.nightly };

export const withChannel = (spec: ServiceSpec, key: ChannelKey, on: boolean): SpecPatch => {
  const exposure = exposureOf[key];
  if (exposure)
    return {
      exposure: {
        ...spec.exposure,
        [exposure]: on,
        ...(key === 'a2a' && !on ? { a2aPublicCard: false } : {}),
      },
    };
  const kind = triggerKindOf[key];
  if (kind) {
    const rest = (spec.triggers ?? []).filter((t) => t.kind !== kind);
    return { triggers: on ? [...rest, newTrigger(kind)] : rest };
  }
  return { batch: on ? { enabled: true } : undefined };
};

export const withTrigger = (spec: ServiceSpec, trigger: Trigger): SpecPatch => ({
  triggers: (spec.triggers ?? []).map((t) => (t.kind === trigger.kind ? trigger : t)),
});

export const withPublicCard = (spec: ServiceSpec, on: boolean): SpecPatch => ({
  exposure: { ...spec.exposure, a2aPublicCard: on },
});

export const piiCategories = ['national-id', 'd-number', 'phone', 'email'];

export type LanguageMode = 'nb' | 'nn' | 'en' | 'same';

export const guardOn = (spec: ServiceSpec, name: string) => spec.guardrails?.[name] !== undefined;

const piiCategoriesOf = (spec: ServiceSpec) => {
  const found = ['pii-before-model', 'pii-out-of-log']
    .map((name) => (spec.guardrails?.[name] as { categories?: unknown } | undefined)?.categories)
    .find(Array.isArray);
  return found ? found.map(String) : piiCategories;
};

export const withGuard = (spec: ServiceSpec, name: string, on: boolean): SpecPatch => {
  const value = name.startsWith('pii-') ? { categories: piiCategoriesOf(spec) } : true;
  return {
    guardrails: on ? { ...spec.guardrails, [name]: value } : without(spec.guardrails, name),
  };
};

export const refuseTopicsOf = (spec: ServiceSpec): string[] => {
  const topics = spec.guardrails?.['refuse-topics'];
  return Array.isArray(topics) ? topics.map(String) : [];
};

export const withRefuseTopics = (spec: ServiceSpec, topics: string[]): SpecPatch => ({
  guardrails: topics.length
    ? { ...spec.guardrails, 'refuse-topics': topics }
    : without(spec.guardrails, 'refuse-topics'),
});

export const languageModeOf = (spec: ServiceSpec): LanguageMode => {
  const mode = (spec.guardrails?.language as { mode?: unknown } | undefined)?.mode;
  return mode === 'nb' || mode === 'nn' || mode === 'en' ? mode : 'same';
};

export const withLanguageMode = (spec: ServiceSpec, mode: LanguageMode): SpecPatch => ({
  guardrails: { ...spec.guardrails, language: { mode } },
});

export const withRisk = (risk: RiskClass): SpecPatch => ({
  riskClass: risk,
  riskConfirmation: undefined,
});

export const riskConfirmationFor = (risk: RiskClass, reasons: string[], at: Date) => ({
  at: at.toISOString().slice(0, 10),
  reasons,
  riskClass: risk,
});

export const withOutputKind = (spec: ServiceSpec, kind: OutputKind): SpecPatch => ({
  output: {
    ...spec.output,
    kind,
    withSources: kind === 'answer' ? spec.output.withSources === true : false,
  },
});

export interface Example {
  input: string;
  output: string;
}

export const examplesOf = (spec: ServiceSpec): Example[] => {
  const raw = spec.strategy.config.examples;
  return (Array.isArray(raw) ? raw : []).map((e) => {
    const text = String(e);
    const at = text.indexOf(' => ');
    return at < 0
      ? { input: text, output: '' }
      : { input: text.slice(0, at), output: text.slice(at + 4) };
  });
};

export const withExamples = (spec: ServiceSpec, examples: Example[]): SpecPatch => ({
  strategy: {
    ...spec.strategy,
    config: examples.length
      ? {
          ...spec.strategy.config,
          examples: examples.map((e) => (e.output ? `${e.input} => ${e.output}` : e.input)),
        }
      : without(spec.strategy.config, 'examples'),
  },
});

export const withStrategy = (spec: ServiceSpec, id: string): SpecPatch => {
  const entry = strategyEntry(id);
  if (!entry) return {};
  const takes = takesOf(id);
  const keep = (key: string, use: string) =>
    use !== 'no' && spec.strategy.config[key] !== undefined
      ? { [key]: spec.strategy.config[key] }
      : {};
  return {
    strategy: {
      id,
      version: entry.version,
      config: {
        ...structuredClone(entry.newConfig),
        ...keep('instructions', takes.instructions),
        ...keep('examples', takes.examples),
        ...keep('languageInstructions', takes.instructions),
      },
    },
  };
};

export const flowOf = (spec: ServiceSpec) => {
  const flow = spec.strategy.id === 'step-flow' ? spec.strategy.config.flow : undefined;
  return typeof flow === 'string' ? flow : undefined;
};

export const withModel = (spec: ServiceSpec, id: string, residency?: string): SpecPatch => ({
  model: {
    ...without(spec.model, 'residency'),
    primary: id,
    ...(residency ? { residency } : {}),
  },
});

export const withFallback = (spec: ServiceSpec, id: string): SpecPatch => ({
  model: id ? { ...spec.model, fallback: id } : without(spec.model, 'fallback'),
});

export const datasetsOf = (spec: ServiceSpec): DatasetRef[] => spec.knowledge?.datasets ?? [];

export const withDatasets = (spec: ServiceSpec, datasets: DatasetRef[]): SpecPatch => ({
  knowledge: { ...spec.knowledge, datasets },
});

export const filterText = (filters: Record<string, unknown> | undefined) =>
  Object.entries(filters ?? {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ');

export const withRuntimeDocuments = (spec: ServiceSpec, on: boolean): SpecPatch => ({
  knowledge: { ...spec.knowledge, runtimeDocuments: on },
});

export const toolRef = (tool: ToolRef) => (typeof tool === 'string' ? tool : tool.use);

export const toolRefsOf = (spec: ServiceSpec) => (spec.tools ?? []).map(toolRef);

export const withTool = (spec: ServiceSpec, ref: string, on: boolean): SpecPatch => {
  const rest = (spec.tools ?? []).filter((t) => toolRef(t) !== ref);
  return { tools: on ? [...rest, ref] : rest };
};

export const improves = (spec: ServiceSpec, what: string) =>
  spec.improve?.allow?.includes(what) === true;

export const withImprove = (spec: ServiceSpec, what: string, on: boolean): SpecPatch => {
  const allow = (spec.improve?.allow ?? []).filter((a) => a !== what);
  return { improve: { ...spec.improve, allow: on ? [...allow, what] : allow } };
};

export const variantsOf = (spec: ServiceSpec): VariantSpec[] =>
  (spec.variants?.length ? spec.variants : ['default']).map((v) =>
    typeof v === 'string' ? { id: v } : v,
  );

export const defaultPublicName = (serviceId: string) => `${serviceId}__default`;

export const publicNameOf = (d: ServiceDefinition) =>
  variantsOf(d.spec)[0]?.publicName ?? defaultPublicName(d.metadata.id);

export const withPublicName = (spec: ServiceSpec, publicName: string): SpecPatch => {
  const [head = { id: 'default' }, ...rest] = variantsOf(spec);
  return {
    variants: [publicName ? { ...head, publicName } : without(head, 'publicName'), ...rest],
  };
};

export const slug = (t: string) =>
  (t || '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const autoPublicName = (name: string) => (slug(name) ? `${slug(name)}__default` : '');

export const datasetRef = (name: string, tenant: string) =>
  name.includes('/') ? name : `${tenant}/${slug(name)}`;

export const renameService = (d: ServiceDefinition, name: string, published: boolean) => {
  const head = variantsOf(d.spec)[0]?.publicName;
  const auto = !published && (!head || head === autoPublicName(d.metadata.name ?? ''));
  return renamed(
    auto ? applySpec(d, (cur) => withPublicName(cur.spec, autoPublicName(name))) : d,
    name,
  );
};
