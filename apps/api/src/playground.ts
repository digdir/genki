import { invalidInputProblem, type SourceRecord } from '@genai/adapter-openai';
import { failureReason } from './failures.js';
import { requestLocale, t } from './i18n/index.js';
import {
  withPlainHeadings,
  type Event,
  type InputField,
  type Part,
  type Principal,
} from '@genai/contracts';
import { BlobError } from '@genai/port-blob';
import { TABLE_MIME } from '@genai/strategy-step-flow';
import type { Residency } from '@genai/port-model';
import type { Context } from 'hono';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  blockStatusFor,
  readBlockPolicy,
  type BlockKind,
  type BlockPolicy,
  type PolicyRule,
} from './building-blocks.js';
import {
  originOf,
  type DraftInputPart,
  type DraftRunFailure,
  type DraftRunOutcome,
  type DraftRunSuccess,
} from './draft-runner.js';
import {
  mapRun,
  RunMapper,
  sourcesMime,
  type RunChange,
  type RunStats,
  type TimelineStep,
} from './run-steps.js';
import { modelDisplayNames, modelsForTenant } from './model-access.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { requireRight, rightLabels, type Right } from './rights.js';

export type PlaygroundOutput = 'text' | 'fields';
export type PlaygroundSetupName = 'setup' | 'compareWith';
export type ModelStatus = 'allowed' | 'requires_approval' | 'not_allowed';

export interface PlaygroundField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'list';
  description: string;
}

export interface PlaygroundSetup {
  service?: {
    id: string;
    version: number | 'draft';
    variant?: string;
    definition?: unknown;
    files?: Record<string, string>;
  };
  model?: string;
  datasets?: string[];
  skills?: string[];
  blocks?: (string | { id: string; config?: unknown })[];
  instructions?: string;
  fields?: PlaygroundField[];
  output: PlaygroundOutput;
}

export type PlaygroundFile =
  string | { name: string; mediaType?: string; data: string } | { name?: string; sample: true };

export type PlaygroundInput =
  { text: string } | { file: PlaygroundFile } | { fields: Record<string, unknown>; text?: string };

export interface PlaygroundTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface PlaygroundRunRequest {
  setup: PlaygroundSetup;
  compareWith?: PlaygroundSetup;
  input: PlaygroundInput;
  history?: PlaygroundTurn[];
  answerLanguage?: 'nb' | 'nn' | 'en';
}

export interface PlaygroundSearchNote {
  document: string;
  reason: string;
}

export interface PlaygroundResult {
  text?: string;
  fields?: Record<string, unknown>;
  table?: unknown;
  csv?: string;
  noAnswer?: true;
  sources: (SourceRecord & { score?: number })[];
  citations?: { index: number; chunkId: string }[];
  clarification?: { question: string; options: string[] };
  byModel: { model: string; inputTokens: number; outputTokens: number; costNok: number }[];
  steps: TimelineStep[];
  stats: RunStats;
  searchNotes: PlaygroundSearchNote[];
  timeMs: number;
  tokensIn: number;
  tokensOut: number;
  costNok: number;
  dataLocation: Residency | null;
  runId: string;
}

export interface PlaygroundQuota {
  usedPercent: number;
  monthlyTokens: number;
}

export type PlaygroundRunResponse = PlaygroundResult & {
  compare?: PlaygroundResult;
  quota: PlaygroundQuota;
};

export interface PlaygroundPolicy {
  block: string;
  rule: string;
  ownedBy: string;
  link: string;
}

export interface PlaygroundRefusal {
  type: 'about:blank';
  title: string;
  status: 403;
  setup: PlaygroundSetupName;
  policy: PlaygroundPolicy;
}

export const playgroundUnavailableType = 'urn:genai:problem:playground-unavailable';

export interface PlaygroundUnavailable {
  type: typeof playgroundUnavailableType;
  status: 502;
  title: string;
  setup: PlaygroundSetupName;
  code: string;
  step?: string;
  detail?: string;
  runId?: string;
}

export interface PlaygroundQuotaExhausted {
  type: 'about:blank';
  title: string;
  status: 429;
  quota: PlaygroundQuota;
}

export interface PlaygroundVersionSetup {
  model: string;
  datasets: string[];
  skills: string[];
  blocks: string[];
  output: PlaygroundOutput;
}

export interface PlaygroundServiceVersion {
  version: number;
  draft: boolean;
  inUse: boolean;
  setup: PlaygroundVersionSetup;
  inputFields?: InputField[];
}

export interface PlaygroundTestSet {
  id: string;
  name: string;
  cases: number;
  service?: string;
}

export interface PlaygroundOptions {
  services: {
    id: string;
    name: string;
    chat: boolean;
    exampleQuestions: string[];
    versions: PlaygroundServiceVersion[];
    latestVersion: number;
  }[];
  models: {
    id: string;
    name: string;
    dataLocation: Residency;
    status: ModelStatus;
    policy?: PlaygroundPolicy;
  }[];
  datasets: { id: string; name: string; dataLocation: Residency; status: ModelStatus }[];
  skills: { id: string; name: string; version: number; ref: string }[];
  blocks: { id: string; name: string; kind: 'guardrail'; status: ModelStatus }[];
  testSets: PlaygroundTestSet[];
  outputs: PlaygroundOutput[];
  quota: PlaygroundQuota;
}

export const defaultMonthlyTokens = 50_000_000;
export const quotaSettingKey = 'usage.monthlyTokens';

const manageRights: Right[] = ['manage-services', 'manage-datasets'];
const disabledTitle =
  'Prøveområdet er slått av for virksomheten. En administrator kan slå det på under Innstillinger.';
const quotaTitle =
  'Kvoten for måneden er brukt opp. Kjøringen er ikke startet, og ingenting er lagret. En administrator kan øke «Tokens per måned» under Innstillinger.';
const retrievalMime = 'application/vnd.genai.retrieval+json';
const maxUploadBytes = 10 * 1024 * 1024;
const uploadFolder = 'playground';

export const sampleFile = {
  name: 'Søknad_2025_007.txt',
  mediaType: 'text/plain; charset=utf-8',
  text: [
    'Søknad om tilskudd',
    '',
    'Søker: Eksempel IL',
    'Organisasjonsnummer: 912 345 678',
    'Omsøkt beløp: 120 000 kr',
    'Formål: Nytt øvingslokale',
    '',
    'Eksempel IL søker om tilskudd til å pusse opp et nytt øvingslokale for barne- og ungdomsgruppene.',
    'Lokalet skal brukes fire kvelder i uka og er åpent for andre lag i kommunen.',
    '',
  ].join('\n'),
};

const field = z.strictObject({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date', 'list']),
  description: z.string().min(1),
});

const setupSchema = z.strictObject({
  service: z
    .strictObject({
      id: z.string().min(1),
      version: z.union([z.number().int().positive(), z.literal('draft')]),
      variant: z.string().min(1).optional(),
      definition: z.unknown().optional(),
      files: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  model: z.string().min(1).optional(),
  datasets: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  blocks: z
    .array(
      z.union([
        z.string().min(1),
        z.strictObject({ id: z.string().min(1), config: z.unknown().optional() }),
      ]),
    )
    .optional(),
  instructions: z.string().min(1).optional(),
  fields: z.array(field).min(1).optional(),
  output: z.enum(['text', 'fields']),
});

const fileSchema = z.union([
  z.string().min(1),
  z.strictObject({
    name: z.string().min(1).max(200),
    mediaType: z.string().min(1).optional(),
    data: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64'),
  }),
  z.strictObject({ name: z.string().min(1).optional(), sample: z.literal(true) }),
]);

export const runSchema = z.strictObject({
  setup: setupSchema,
  answerLanguage: z.enum(['nb', 'nn', 'en']).optional(),
  compareWith: setupSchema.optional(),
  history: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant']),
        text: z.string().max(20_000),
      }),
    )
    .max(20)
    .optional(),
  input: z.union([
    z.strictObject({ text: z.string().trim().min(1) }),
    z.strictObject({ file: fileSchema }),
    z.strictObject({
      fields: z.record(z.string(), z.unknown()),
      text: z.string().trim().optional(),
    }),
  ]),
});

const defaultFields: PlaygroundField[] = [
  { name: 'facts', type: 'list', description: 'Opplysninger hentet ut fra dokumentet' },
];

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export const withAnswerLanguage = <D>(
  definition: D,
  language: 'nb' | 'nn' | 'en' | undefined,
): D => {
  if (!language) return definition;
  const d = record(definition);
  const spec = record(d.spec);
  return {
    ...d,
    spec: {
      ...spec,
      guardrails: { ...record(spec.guardrails), language: { mode: language, rewrite: false } },
    },
  } as D;
};

const problem = (
  c: Context,
  status: 400 | 401 | 404 | 409 | 413 | 422,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const bareId = (ref: string) => (ref.includes('@') ? ref.slice(0, ref.lastIndexOf('@')) : ref);

const outputFieldsOf = (parts: Part[]) => {
  const json = parts.find((p) => p.mime === 'application/json' && p.body.kind === 'json');
  return json && json.body.kind === 'json' ? record(json.body.json) : undefined;
};

const tableOf = (parts: Part[]) => {
  const json = parts.find((p) => p.mime === TABLE_MIME && p.body.kind === 'json');
  if (json?.body.kind !== 'json') return undefined;
  const csv = parts.find((p) => p.mime === 'text/csv' && p.body.kind === 'text');
  return { table: json.body.json, ...(csv?.body.kind === 'text' ? { csv: csv.body.text } : {}) };
};

const skippedOf = (attribution: unknown): PlaygroundSearchNote[] => {
  const skipped = record(attribution).skipped;
  return (Array.isArray(skipped) ? skipped : []).flatMap((item) => {
    const { document, reason } = record(item);
    return typeof document === 'string' && typeof reason === 'string' ? [{ document, reason }] : [];
  });
};

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v) : [];

export const questionsIn = (value: unknown, locale: 'nb' | 'en') =>
  (Array.isArray(value) ? value : []).flatMap((q) => {
    const text = typeof q === 'string' ? q : record(q)[locale];
    return typeof text === 'string' && text ? [text] : [];
  });

const toolIds = (value: unknown) =>
  (Array.isArray(value) ? value : []).flatMap((t) => {
    const id = typeof t === 'string' ? t : text(record(t).use);
    return id ? [id] : [];
  });

const datasetIds = (spec: Record<string, unknown>) =>
  (Array.isArray(record(spec.knowledge).datasets)
    ? (record(spec.knowledge).datasets as unknown[])
    : []
  ).flatMap((d) => {
    const id = text(record(d).dataset);
    return id ? [id] : [];
  });

const versionSetup = (definition: unknown): PlaygroundVersionSetup => {
  const spec = record(record(definition).spec);
  return {
    model: text(record(spec.model).primary) ?? '',
    datasets: datasetIds(spec),
    skills: strings(spec.skills),
    blocks: [...toolIds(spec.tools), ...Object.keys(record(spec.guardrails))],
    output: record(spec.output).kind === 'fields' ? 'fields' : 'text',
  };
};

const ownerName = (owner: string) => (owner.toLowerCase() === 'digdir' ? 'Digdir' : owner);

const policyFrom = (
  block: string,
  rule: PolicyRule | undefined,
  fallback: string,
  link: string,
) => ({
  block,
  rule: rule?.text ?? fallback,
  ownedBy: ownerName(rule?.ownedBy ?? 'digdir'),
  link: rule?.match.residency ? '#/settings' : link,
});

const verdict = (
  policy: BlockPolicy,
  kind: BlockKind,
  id: string,
  dataLocation: Residency | null,
): { status: ModelStatus; policy?: PlaygroundPolicy } => {
  const found = blockStatusFor(policy, { kind, id, dataLocation });
  if (found.status === 'not_allowed')
    return {
      status: 'not_allowed',
      policy: policyFrom(
        id,
        found.blocked,
        t('services.notAllowedHere', { id }),
        '#/building-blocks',
      ),
    };
  if (found.status === 'requires_approval' || found.status === 'pending_approval')
    return {
      status: 'requires_approval',
      policy: policyFrom(
        id,
        found.approval,
        t('services.needsApproval', { id }),
        '#/building-blocks',
      ),
    };
  return { status: 'allowed' };
};

const safeSegment = (name: string) => {
  const cleaned = name
    .slice(name.lastIndexOf('/') + 1)
    .replace(/[^A-Za-z0-9æøåÆØÅ._-]+/g, '_')
    .replace(/^[^A-Za-z0-9æøåÆØÅ]+/, '')
    .slice(0, 120);
  return cleaned || 'fil';
};

const textual = (mediaType: string) =>
  mediaType.startsWith('text/') || mediaType.split(';')[0] === 'application/json';

const citationsOf = (parts: Part[]) =>
  parts.flatMap((p) => {
    const citations = p.meta?.citations;
    return Array.isArray(citations)
      ? citations.flatMap((c) => {
          const { index, chunkId } = record(c);
          return typeof index === 'number' && typeof chunkId === 'string'
            ? [{ index, chunkId }]
            : [];
        })
      : [];
  });

const clarificationOf = (parts: Part[]) => {
  const json = parts.find((p) => p.mime === sourcesMime && p.body.kind === 'json');
  const found = record(
    json?.body.kind === 'json' ? record(json.body.json).clarification : undefined,
  );
  const question = text(found.question);
  return question ? { question, options: strings(found.options) } : undefined;
};

const attributionsOf = (parts: Part[]) =>
  parts.flatMap((p) =>
    p.mime === retrievalMime && p.body.kind === 'json' ? [record(p.body.json).attribution] : [],
  );

export const playgroundModule: PlatformModuleFactory = () => ({
  id: 'playground',
  mount: (app, deps) => {
    const enabled = (tenant: string) =>
      deps.settings.effective(tenant)['playground.enabled']?.value !== false;

    const guard = async (
      c: Context,
    ): Promise<{ principal: Principal; tenant: string } | Response> => {
      const principal = await deps.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Unauthorized');
      const tenant = c.req.param('tenant') ?? '';
      const scoped = deps.access(principal, tenant, c.req.raw);
      if (!scoped) return problem(c, 404, 'Not found');
      if (!manageRights.some((right) => requireRight(scoped, tenant, right).ok))
        return c.json(
          {
            type: 'about:blank',
            title: `Du trenger rettigheten «${rightLabels['manage-services']}» eller «${rightLabels['manage-datasets']}»`,
            status: 403,
            errors: manageRights.map((right) => ({ path: 'right', message: right })),
          },
          403,
          { 'content-type': 'application/problem+json' },
        );
      if (!enabled(tenant)) return problem(c, 409, disabledTitle);
      return { principal: scoped, tenant };
    };

    const modelResidency = (id: string) => deps.models.models().get(id)?.residency;
    const datasetResidency = (id: string) => deps.knowledge.datasets().get(id)?.residency;

    const refusalOf = (policy: BlockPolicy, definition: unknown) => {
      const spec = record(record(definition).spec);
      const model = record(spec.model);
      const models = [model.primary, model.fallback, ...Object.values(record(model.roles))].filter(
        (m): m is string => typeof m === 'string',
      );
      const checks = [
        ...models.map((m) => verdict(policy, 'model', m, modelResidency(m) ?? null)),
        ...datasetIds(spec).map((d) => verdict(policy, 'dataset', d, datasetResidency(d) ?? null)),
        ...strings(spec.skills).map((s) => verdict(policy, 'skill', bareId(s), null)),
        ...toolIds(spec.tools).map((t) => verdict(policy, 'tool', bareId(t), null)),
        ...Object.keys(record(spec.guardrails)).map((g) => verdict(policy, 'guardrail', g, null)),
      ];
      return checks.find((v) => v.status !== 'allowed')?.policy;
    };

    const skillRef = async (tenant: string, skill: string) => {
      if (skill.includes('@')) return skill;
      const found = await deps.definitions.get('Skill', tenant, skill);
      return found ? `${skill}@${found.version}` : skill;
    };

    const guardrailConfig = (id: string, config: unknown) => {
      if (config !== undefined) return config;
      const schema = deps.plugins.guardrails.get(id);
      if (!schema || schema.safeParse({}).success) return {};
      return schema.safeParse(true).success ? true : {};
    };

    const withModel = (definition: Record<string, unknown>, model: string | undefined) => {
      if (!model) return definition;
      const spec = record(definition.spec);
      return {
        ...definition,
        spec: {
          ...spec,
          model: { primary: model, residency: modelResidency(model) ?? 'global' },
        },
      };
    };

    const built = async (
      tenant: string,
      setup: PlaygroundSetup,
    ): Promise<
      | { ok: true; definition: Record<string, unknown>; files: Record<string, string> }
      | { ok: false; path: string; message: string }
    > => {
      if (setup.service) {
        const { id, version } = setup.service;
        if (version === 'draft') {
          const raw = setup.service.definition;
          if (raw === undefined)
            return { ok: false, path: 'service.definition', message: 'send the draft definition' };
          const parsed = typeof raw === 'string' ? (parseYaml(raw) as unknown) : raw;
          return {
            ok: true,
            definition: withModel(record(parsed), setup.model),
            files: setup.service.files ?? {},
          };
        }
        const found = await deps.definitions.get('Service', tenant, id, version);
        if (!found)
          return { ok: false, path: 'service', message: `no version ${version} of ${id}` };
        return {
          ok: true,
          definition: withModel(structuredClone(record(found.definition)), setup.model),
          files: found.files,
        };
      }
      if (!setup.model) return { ok: false, path: 'model', message: 'choose a model or a service' };
      const datasets = setup.datasets ?? [];
      const instructions =
        setup.instructions ??
        (setup.output === 'fields'
          ? t('services.extractInstructions')
          : t('services.answerInstructions'));
      const tools: string[] = [];
      const guardrails: Record<string, unknown> = {};
      for (const block of setup.blocks ?? []) {
        const id = typeof block === 'string' ? block : block.id;
        if (/@\d/.test(id)) tools.push(id);
        else
          guardrails[id] = guardrailConfig(
            id,
            typeof block === 'string' ? undefined : block.config,
          );
      }
      return {
        ok: true,
        files: {},
        definition: {
          apiVersion: 'genai/v1',
          kind: 'Service',
          metadata: { tenant, id: 'playground', name: 'Prøveområdet' },
          spec: {
            purpose: 'Prøve et oppsett i prøveområdet',
            riskClass: 'minimal',
            input: { accepts: ['text/plain', 'application/pdf'] },
            output:
              setup.output === 'fields'
                ? { kind: 'fields', fields: setup.fields ?? defaultFields }
                : { kind: 'answer', withSources: datasets.length > 0 },
            strategy:
              datasets.length > 0
                ? { id: 'rag-single-shot', version: 1, config: { instructions } }
                : { id: 'single-call', version: 1, config: { instructions } },
            knowledge: { datasets: datasets.map((dataset) => ({ dataset })) },
            tools,
            skills: await Promise.all((setup.skills ?? []).map((k) => skillRef(tenant, k))),
            guardrails,
            model: { primary: setup.model, residency: modelResidency(setup.model) ?? 'global' },
          },
        },
      };
    };

    const searchNotesOf = (run: DraftRunSuccess, events: Event[]) => {
      const seen = new Map<string, PlaygroundSearchNote>();
      const attributions = [
        ...attributionsOf(run.parts),
        ...events.flatMap((e) => (e.type === 'kernel.notice' ? [e.data] : [])),
      ];
      for (const note of attributions.flatMap(skippedOf))
        if (!seen.has(note.document)) seen.set(note.document, note);
      return [...seen.values()];
    };

    const resultOf = async (
      run: DraftRunSuccess,
      output: PlaygroundOutput,
      details: boolean,
      live?: RunMapper,
    ): Promise<PlaygroundResult> => {
      const events: Event[] = [];
      for await (const event of deps.events(run.task)) events.push(event);
      const mapper = live ?? mapRun(events, { details });
      const fields = output === 'fields' ? outputFieldsOf(run.parts) : undefined;
      const table = tableOf(run.parts);
      const citations = citationsOf(run.parts);
      const clarification = clarificationOf(run.parts);
      return {
        ...(fields ? { fields } : table ? table : { text: run.answer }),
        ...(run.noAnswer && !clarification ? { noAnswer: true as const } : {}),
        sources: run.sources.map(withPlainHeadings).map((source) => {
          const score = mapper.hits.get(source.chunkId)?.score;
          return score === undefined ? source : { ...source, score };
        }),
        ...(citations.length ? { citations } : {}),
        ...(clarification ? { clarification } : {}),
        byModel: run.usage.byModel.map((m) => ({
          model: m.model,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          costNok: m.costMicroNok / 1_000_000,
        })),
        steps: mapper.steps,
        stats: mapper.stats(),
        searchNotes: searchNotesOf(run, events),
        timeMs: run.timing.durationMs,
        tokensIn: run.usage.inputTokens,
        tokensOut: run.usage.outputTokens,
        costNok: run.costNok,
        dataLocation: run.dataLocation,
        runId: run.task,
      };
    };

    const quotaOf = async (tenant: string): Promise<PlaygroundQuota & { exhausted: boolean }> => {
      const now = new Date();
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      let used = 0;
      for (const tracked of await deps.tasks.all(tenant)) {
        if (tracked.status === 'failed' || tracked.status === 'cancelled') continue;
        const task = await deps.task(tracked.task);
        if (!task || task.createdAt < month) continue;
        if (originOf(task.service.capability.id) === 'assistant') continue;
        used += (task.usage.inputTokens ?? 0) + (task.usage.outputTokens ?? 0);
      }
      const setting = deps.settings.effective(tenant)[quotaSettingKey]?.value;
      const limit = typeof setting === 'number' && setting > 0 ? setting : defaultMonthlyTokens;
      return {
        usedPercent: Math.round((used / limit) * 1000) / 10,
        monthlyTokens: limit,
        exhausted: used >= limit,
      };
    };

    const quotaView = ({ usedPercent, monthlyTokens }: PlaygroundQuota): PlaygroundQuota => ({
      usedPercent,
      monthlyTokens,
    });

    const stored = async (
      tenant: string,
      file: Exclude<PlaygroundFile, string>,
    ): Promise<{ path: string; mediaType: string; body: Uint8Array }> => {
      const upload =
        'sample' in file
          ? {
              name: sampleFile.name,
              mediaType: sampleFile.mediaType,
              body: new TextEncoder().encode(sampleFile.text),
            }
          : {
              name: file.name,
              mediaType: file.mediaType ?? 'application/octet-stream',
              body: new Uint8Array(Buffer.from(file.data, 'base64')),
            };
      if (upload.body.byteLength > maxUploadBytes)
        throw new BlobError('too_large', `files are limited to ${maxUploadBytes} bytes`);
      const path = `${uploadFolder}/${crypto.randomUUID()}/${safeSegment(upload.name)}`;
      await deps.blobs.put({ tenant, path }, upload.body, upload.mediaType);
      return { path, mediaType: upload.mediaType, body: upload.body };
    };

    const fileParts = async (
      tenant: string,
      file: PlaygroundFile,
    ): Promise<
      { parts: DraftInputPart[]; uploaded?: string } | { path: string; message: string }
    > => {
      if (typeof file === 'string') {
        const found = await deps.blobs.get({ tenant, path: file });
        if (!found) return { path: 'input.file', message: `no file ${file}` };
        return {
          parts: textual(found.info.contentType)
            ? [{ kind: 'text', text: new TextDecoder().decode(found.body) }]
            : [{ kind: 'file', blob: file }],
        };
      }
      const saved = await stored(tenant, file);
      return {
        uploaded: saved.path,
        parts: textual(saved.mediaType)
          ? [{ kind: 'text', text: new TextDecoder().decode(saved.body) }]
          : [{ kind: 'file', blob: saved.path }],
      };
    };

    app.get('/tenants/:tenant/playground/options', async (c) => {
      const g = await guard(c);
      if (g instanceof Response) return g;
      const policy = await readBlockPolicy(deps.configEntries, g.tenant);
      const listed = await deps.definitions.list(g.tenant);
      const unordered = await Promise.all(
        listed
          .filter((d) => d.kind === 'Service')
          .map(async ({ id }) => {
            const versions = await deps.definitions.versions('Service', g.tenant, id);
            const latest = versions.at(-1);
            const latestSpec = record(record(latest?.definition).spec);
            return {
              id,
              name: text(record(latest?.definition.metadata).name) ?? id,
              chat: record(latestSpec.exposure).chat === true,
              exampleQuestions: questionsIn(latestSpec.exampleQuestions, requestLocale()),
              versions: (
                await Promise.all(
                  versions.map(async (v) => {
                    const fields = await deps.drafts.inputFields(
                      g.principal,
                      g.tenant,
                      v.definition,
                    );
                    return {
                      version: v.version,
                      draft: false,
                      inUse: v.version === latest?.version,
                      setup: versionSetup(v.definition),
                      ...(fields.length ? { inputFields: fields } : {}),
                    };
                  }),
                )
              ).reverse(),
              latestVersion: latest?.version ?? 0,
            };
          }),
      );
      const services = unordered.sort(
        (a, b) => Number(b.chat) - Number(a.chat) || a.name.localeCompare(b.name, 'nb'),
      );
      const testSets = (await deps.evalStores.testSets.list(g.tenant)).map((set) => ({
        id: set.metadata.id,
        name: set.metadata.name,
        cases: set.spec.cases.length,
        ...(set.spec.service ? { service: set.spec.service } : {}),
      }));
      const quota = await quotaOf(g.tenant);
      const skills = (
        await Promise.all(
          listed
            .filter((d) => d.kind === 'Skill')
            .map(async ({ id }) => {
              const found = await deps.definitions.get('Skill', g.tenant, id);
              return found
                ? [
                    {
                      id,
                      name: text(record(found.definition.metadata).name) ?? id,
                      version: found.version,
                      ref: `${id}@${found.version}`,
                    },
                  ]
                : [];
            }),
        )
      ).flat();
      const tenantModels = modelsForTenant(deps, g.tenant);
      const modelNames = modelDisplayNames(tenantModels);
      const options: PlaygroundOptions = {
        services,
        models: tenantModels.map((m) => {
          const v = verdict(policy, 'model', m.id, m.residency);
          return {
            id: m.id,
            name: modelNames.get(m.id) ?? m.id,
            dataLocation: m.residency,
            status: v.status,
            ...(v.policy ? { policy: v.policy } : {}),
          };
        }),
        datasets: [...deps.knowledge.datasets()]
          .filter(([, d]) => !d.tenants || d.tenants.includes(g.tenant))
          .map(([id, d]) => ({
            id,
            name: d.name ?? id,
            dataLocation: d.residency,
            status: verdict(policy, 'dataset', id, d.residency).status,
          })),
        skills,
        blocks: [...deps.plugins.guardrails.keys()].map((id) => ({
          id,
          name: id,
          kind: 'guardrail' as const,
          status: verdict(policy, 'guardrail', id, null).status,
        })),
        testSets,
        outputs: ['text', 'fields'],
        quota: quotaView(quota),
      };
      return c.json(options);
    });

    type Guarded = { principal: Principal; tenant: string };
    interface Prepared {
      request: PlaygroundRunRequest;
      definitions: {
        name: PlaygroundSetupName;
        setup: PlaygroundSetup;
        definition: Record<string, unknown>;
        files: Record<string, string>;
      }[];
      parts: DraftInputPart[];
      uploaded?: string;
    }

    const prepare = async (c: Context, g: Guarded): Promise<Prepared | Response> => {
      const parsed = runSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success)
        return c.json(
          {
            type: 'about:blank',
            title: 'Invalid request',
            status: 400,
            errors: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          400,
          { 'content-type': 'application/problem+json' },
        );
      const request = parsed.data as PlaygroundRunRequest;
      const named: [PlaygroundSetupName, PlaygroundSetup][] = [
        ['setup', request.setup],
        ...(request.compareWith
          ? [['compareWith', request.compareWith] as [PlaygroundSetupName, PlaygroundSetup]]
          : []),
      ];
      const policy = await readBlockPolicy(deps.configEntries, g.tenant);
      const definitions: Prepared['definitions'] = [];
      for (const [name, setup] of named) {
        const definition = await built(g.tenant, setup);
        if (!definition.ok)
          return c.json(
            {
              type: 'about:blank',
              title: 'Invalid setup',
              status: 422,
              errors: [{ path: `${name}.${definition.path}`, message: definition.message }],
            },
            422,
            { 'content-type': 'application/problem+json' },
          );
        const refused = refusalOf(policy, definition.definition);
        if (refused) {
          const refusal: PlaygroundRefusal = {
            type: 'about:blank',
            title: `${refused.block} kan ikke brukes i prøveområdet`,
            status: 403,
            setup: name,
            policy: refused,
          };
          return c.json(refusal, 403, { 'content-type': 'application/problem+json' });
        }
        definitions.push({
          name,
          setup,
          definition: definition.definition,
          files: definition.files,
        });
      }
      const quota = await quotaOf(g.tenant);
      if (quota.exhausted) {
        const exhausted: PlaygroundQuotaExhausted = {
          type: 'about:blank',
          title: quotaTitle,
          status: 429,
          quota: quotaView(quota),
        };
        return c.json(exhausted, 429, { 'content-type': 'application/problem+json' });
      }
      if ('fields' in request.input)
        return {
          request,
          definitions,
          parts: request.input.text ? [{ kind: 'text', text: request.input.text }] : [],
        };
      if ('text' in request.input)
        return { request, definitions, parts: [{ kind: 'text', text: request.input.text }] };
      try {
        const found = await fileParts(g.tenant, request.input.file);
        if (!('parts' in found))
          return problem(c, 422, 'Invalid input', [{ path: found.path, message: found.message }]);
        return {
          request,
          definitions,
          parts: found.parts,
          ...(found.uploaded ? { uploaded: found.uploaded } : {}),
        };
      } catch (error) {
        if (!(error instanceof BlobError)) throw error;
        return error.code === 'too_large'
          ? problem(c, 413, 'Filen er for stor til å prøves her.', [
              { path: 'input.file', message: error.message },
            ])
          : problem(c, 422, 'Filen kan ikke brukes.', [
              { path: 'input.file', message: error.message },
            ]);
      }
    };

    const runOne = (
      g: Guarded,
      prepared: Prepared,
      d: Prepared['definitions'][number],
      onEvent?: (event: Event) => void,
    ) =>
      deps.drafts.run({
        principal: g.principal,
        tenant: g.tenant,
        definition: withAnswerLanguage(d.definition, prepared.request.answerLanguage),
        files: d.files,
        parts: prepared.parts,
        origin: 'playground',
        ...(d.setup.service?.variant ? { variant: d.setup.service.variant } : {}),
        input: 'fields' in prepared.request.input ? prepared.request.input.fields : {},
        ...(prepared.request.history ? { history: prepared.request.history } : {}),
        ...(onEvent ? { onEvent } : {}),
      });

    const failureOf = (
      g: Guarded,
      outcome: DraftRunFailure,
      name: PlaygroundSetupName,
    ): { status: 400 | 403 | 422 | 502; body: unknown } => {
      if (outcome.status === 400) return { status: 400, body: invalidInputProblem(outcome.errors) };
      if (outcome.status === 502) {
        const code = outcome.code ?? 'model_error';
        const detailed = requireRight(g.principal, g.tenant, 'manage-services').ok;
        const unavailable: PlaygroundUnavailable = {
          type: playgroundUnavailableType,
          status: 502,
          title:
            code === 'model_error'
              ? t('services.modelUnavailable')
              : `${failureReason({ code, ...(outcome.step ? { step: outcome.step } : {}) })} ${t('services.notCounted')}`,
          setup: name,
          code,
          ...(outcome.step ? { step: outcome.step } : {}),
          ...(detailed && outcome.errors[0]?.message ? { detail: outcome.errors[0].message } : {}),
          ...(outcome.task ? { runId: outcome.task } : {}),
        };
        return { status: 502, body: unavailable };
      }
      return {
        status: outcome.status,
        body: {
          type: 'about:blank',
          title: outcome.status === 403 ? 'Forbidden' : 'Invalid setup',
          status: outcome.status,
          errors: outcome.errors.map((e) => ({ ...e, path: `${name}.${e.path}` })),
        },
      };
    };

    const mayDetail = (g: Guarded) => requireRight(g.principal, g.tenant, 'manage-services').ok;

    app.post('/tenants/:tenant/playground/runs', async (c) => {
      const g = await guard(c);
      if (g instanceof Response) return g;
      const prepared = await prepare(c, g);
      if (prepared instanceof Response) return prepared;
      const { definitions, uploaded } = prepared;
      const outcomes: DraftRunOutcome[] = await Promise.all(
        definitions.map((d) => runOne(g, prepared, d)),
      );
      if (uploaded && outcomes.some((o) => !o.ok))
        await deps.blobs.delete({ tenant: g.tenant, path: uploaded });
      for (const [i, outcome] of outcomes.entries()) {
        if (outcome.ok) continue;
        const failed = failureOf(g, outcome, definitions[i]?.name ?? 'setup');
        return c.json(failed.body, failed.status, {
          'content-type': 'application/problem+json',
        });
      }
      const results = await Promise.all(
        outcomes.map((o, i) =>
          resultOf(o as DraftRunSuccess, definitions[i]?.setup.output ?? 'text', mayDetail(g)),
        ),
      );
      const [first, compare] = results as [PlaygroundResult, PlaygroundResult | undefined];
      const response: PlaygroundRunResponse = {
        ...first,
        ...(compare ? { compare } : {}),
        quota: quotaView(await quotaOf(g.tenant)),
      };
      return c.json(response);
    });

    app.post('/tenants/:tenant/playground/runs/stream', async (c) => {
      const g = await guard(c);
      if (g instanceof Response) return g;
      const prepared = await prepare(c, g);
      if (prepared instanceof Response) return prepared;
      const details = mayDetail(g);
      const encoder = new TextEncoder();
      let open = true;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const send = (event: string, data: unknown) => {
            if (!open) return;
            try {
              controller.enqueue(
                encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
              );
            } catch {
              open = false;
            }
          };
          const forward = (setup: PlaygroundSetupName, mapper: RunMapper, changes: RunChange[]) => {
            for (const change of changes) {
              if (change.kind === 'step') send('step', { setup, step: change.step });
              else if (change.kind === 'remove') send('remove', { setup, id: change.id });
              else if (change.kind === 'delta')
                send('delta', { setup, text: change.text, channel: change.channel });
              else if (change.kind === 'retract') send('retract', { setup, reason: change.reason });
              else send('status', { setup, status: change.status });
            }
            if (changes.some((ch) => ch.kind !== 'delta'))
              send('stats', { setup, stats: mapper.stats() });
          };
          const work = async () => {
            const outcomes = await Promise.all(
              prepared.definitions.map(async (d) => {
                const mapper = new RunMapper({ details });
                let started = false;
                const outcome = await runOne(g, prepared, d, (event) => {
                  if (!started) {
                    started = true;
                    send('started', { setup: d.name, runId: event.task, startedAt: event.ts });
                  }
                  forward(d.name, mapper, mapper.push(event));
                });
                if (outcome.ok)
                  send('result', {
                    setup: d.name,
                    result: await resultOf(outcome, d.setup.output, details, mapper),
                  });
                else send('failed', { setup: d.name, problem: failureOf(g, outcome, d.name).body });
                return outcome;
              }),
            );
            if (prepared.uploaded && outcomes.some((o) => !o.ok))
              await deps.blobs.delete({ tenant: g.tenant, path: prepared.uploaded });
            send('done', { quota: quotaView(await quotaOf(g.tenant)) });
          };
          work()
            .catch((error: unknown) =>
              send('failed', {
                setup: 'setup',
                problem: {
                  type: playgroundUnavailableType,
                  status: 502,
                  title: t('services.modelUnavailable'),
                  setup: 'setup',
                  code: 'strategy_error',
                  ...(details && error instanceof Error ? { detail: error.message } : {}),
                },
              }),
            )
            .finally(() => {
              if (!open) return;
              open = false;
              controller.close();
            });
        },
        cancel: () => {
          open = false;
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
      });
    });
  },
});
