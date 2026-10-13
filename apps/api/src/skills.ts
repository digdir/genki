import { inflateRawSync } from 'node:zlib';
import type { Principal } from '@genai/contracts';
import {
  skillDefinition,
  validateDefinition,
  type ServiceDefinition,
  type SkillDefinition,
  type ValidationError,
} from '@genai/definitions';
import {
  contractAssertions,
  criteriaJudgePrompt,
  rubricJudge,
  type EvalContext,
  type Observation,
  type Score,
  type TestCase,
} from '@genai/eval';
import { BlobError, storeZip, type ZipEntry } from '@genai/port-blob';
import { parseSkillRef, skillDecorator, skillResolver } from '@genai/composition';
import type { RuntimeSkill } from '@genai/strategy-single-call';
import { optimiserResultMime, type OptimiserResult } from '@genai/strategy-builder';
import type { Context, Env, Hono, Schema } from 'hono';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { actorOf, routeOnly, type AdminHandler } from './admin.js';
import { t } from './i18n/index.js';
import { appendVersion, VersionConflict, type ConfigEntry } from './config-store.js';
import type { DraftInputPart, DraftRunOutcome } from './draft-runner.js';
import { ephemeralId, modelChoice, type ModelChoice } from './model-choice.js';
import type { ModuleDeps, MountDeps, PlatformModuleFactory } from './platform-modules.js';
import {
  defaultModelOf,
  optimiserServiceId,
  platformService,
  runPlatformService,
  runsPlatformServices,
} from './platform-services.js';
import { requireRight, rightRefused, type Right } from './rights.js';
import { actorNameOf, changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';

export type SkillStatus = 'draft' | 'published';
export type SkillShareState = 'none' | 'pending_digdir' | 'shared' | 'rejected';
export type SkillCaseType = 'criteria' | 'fields' | 'must_reject';
export type SkillRequirementId =
  'tested-on-draft' | 'pass-rate' | 'must-reject' | 'published-tools';

export interface SkillPublisher {
  type: 'own' | 'digdir' | 'shared';
  name: string;
}

export interface SkillSummary {
  id: string;
  owner: string;
  name: string;
  description: string;
  version: number | null;
  draftRevision: number | null;
  hasChanges: boolean;
  status: SkillStatus;
  share: SkillShareState;
  sharedWith: number;
  publisher: SkillPublisher;
  usedBy: number;
  services: SkillServiceUse[];
  readOnly: boolean;
}

export interface SkillServiceUse {
  service: string;
  name: string;
  version: number;
}

export interface SkillDraft {
  revision: number;
  definition: Record<string, unknown>;
  by: string;
  at: string;
  reason: string;
  problems: ValidationError[];
  copiedFrom?: { owner: string; id: string; version: number };
}

export interface SkillVersion {
  version: number;
  publishedAt: string;
  by: string;
  reason: string;
  score: number | null;
  passed?: number;
  total?: number;
}

export interface SkillCaseResult {
  index: number;
  input: string;
  expected: string | Record<string, unknown>;
  type: SkillCaseType;
  context?: string;
  dataset?: string;
  passed: boolean;
  answer: string;
  fields?: Record<string, unknown>;
  score: number | null;
  reason?: string;
  task?: string;
  costNok: number;
}

export interface SkillTestRun {
  id: number;
  skill: string;
  draftRevision: number;
  startedAt: string;
  endedAt: string;
  by: string;
  model: string;
  judge: string | null;
  passed: number;
  total: number;
  passRate: number;
  threshold: number;
  costNok: number;
  cases: SkillCaseResult[];
}

export interface SkillRequirement {
  id: SkillRequirementId;
  label: string;
  met: boolean;
  detail?: string;
  reason?: 'no_cases' | 'not_run' | 'stale';
  passedCases?: number;
  total?: number;
  threshold?: number;
  unpublishedTools?: string[];
}

export interface SkillFix {
  id: string;
  fixId: string;
  skill: string;
  draftRevision: number;
  before: string;
  after: string;
  reasons: string[];
  status: 'proposed' | 'applied';
}

export interface SkillShare {
  id: string;
  tenant: string;
  skill: string;
  version: number;
  state: SkillShareState;
  by: string;
  at: string;
  reason: string;
  decision?: { approved: boolean; by: string; byName?: string; at: string; reason: string };
}

export interface SkillDetail extends SkillSummary {
  draft: SkillDraft | null;
  published: SkillDefinition | null;
  versions: SkillVersion[];
  lastTestRun: SkillTestRun | null;
  stale: boolean;
  threshold: number;
  requirements: SkillRequirement[];
  shareRequest: SkillShare | null;
  attachmentSizes: Record<string, number>;
}

export interface SkillUsage {
  latestVersion: number | null;
  usedBy: {
    tenant: string;
    service: string;
    name: string;
    version: number;
    updateAvailable: boolean;
  }[];
}

export interface SkillToolOption {
  id: string;
  name: string;
  versions: string[];
}

export interface SkillAttachmentUpload {
  name: string;
  blob: string;
  size: number;
}

export interface SkillPublishResult {
  ok: boolean;
  version?: number;
  publishedAt?: string;
  task?: string;
  requirements: SkillRequirement[];
}

interface DraftSpec {
  definition: Record<string, unknown>;
  copiedFrom?: { owner: string; id: string; version: number };
}

interface ShareSpec {
  skill: string;
  version: number;
  state: SkillShareState;
  byName?: string;
  decision?: SkillShare['decision'];
}

const byNameOf = (c: Context): { byName?: string } => {
  const name = actorNameOf(c);
  return name ? { byName: name } : {};
};

const kinds = {
  draft: 'skill-draft',
  run: 'skill-test-run',
  share: 'skill-share',
  publication: 'skill-publication',
  fix: 'skill-fix',
} as const;

const defaultThreshold = 0.9;
const maxZipBytes = 20 * 1024 * 1024;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const reservedIds = new Set(['import', 'imports']);
const validId = (id: string) => slugPattern.test(id) && !reservedIds.has(id);
const invalidId = {
  path: 'id',
  message: 'must be lowercase letters, digits and dashes, and not import or imports',
};
const segmentPattern = /^[A-Za-z0-9æøåÆØÅ][A-Za-z0-9æøåÆØÅ._-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const casesOf = (definition: Record<string, unknown>): unknown[] => {
  const spec = isRecord(definition.spec) ? definition.spec : (definition.spec = {});
  const testset = isRecord(spec.testset) ? spec.testset : (spec.testset = { cases: [] });
  if (!Array.isArray(testset.cases)) testset.cases = [];
  return testset.cases as unknown[];
};

const shareId = (tenant: string, skill: string) => `${tenant}-${skill}`;

const splitShareId = (id: string) => ({ tenant: id.slice(0, 9), skill: id.slice(10) });

const percent = (value: number) => Math.round(value * 100);

const contentTypeOf = (name: string) =>
  ({
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    csv: 'text/csv',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  })[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export const readZip = (zip: Uint8Array): ZipEntry[] => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.byteLength - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a zip file');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('broken zip directory');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    total += size;
    if (total > maxZipBytes) throw new Error('the package is too large');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + compressed);
    if (method === 0) entries.push({ name, data: raw });
    else if (method === 8)
      entries.push({ name, data: new Uint8Array(inflateRawSync(raw, { maxOutputLength: size })) });
    else throw new Error(`unsupported compression in ${name}`);
  }
  return entries;
};

const compareVersions = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

const frontmatter = (text: string) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error('SKILL.md needs a frontmatter block');
  return { head: parseYaml(match[1] ?? '') as unknown, body: (match[2] ?? '').trim() };
};

export const skillActions = [
  'platform.skill.create',
  'platform.skill.import',
  'platform.skill.draft.save',
  'platform.skill.testcase.delete',
  'platform.skill.fix.propose',
  'platform.skill.fix.apply',
  'platform.skill.share.request',
  'platform.skill.share.withdraw',
  'platform.skill.copy',
  'platform.skill.attachment.upload',
] as const;

type SkillAction = (typeof skillActions)[number];

export const skillsModule: PlatformModuleFactory = (deps: ModuleDeps) => {
  const pending = new Map<string, RuntimeSkill>();

  const { resolveSkill, toRuntime } = skillResolver({
    definitions: deps.definitions,
    configEntries: deps.configEntries,
  });

  const shares = async () =>
    (await deps.configEntries.latest({ kind: kinds.share })).filter(
      (e) => !e.deleted,
    ) as ConfigEntry<ShareSpec>[];

  const shareOf = async (tenant: string, skill: string) =>
    (await deps.configEntries.history(kinds.share, tenant, skill)).at(-1) as
      ConfigEntry<ShareSpec> | undefined;

  const decorateCapability = skillDecorator({ resolveSkill, toRuntime }, (tenant, service) =>
    pending.get(`${tenant}/${service}`),
  );

  const draftOf = async (tenant: string, id: string) =>
    (await deps.configEntries.history(kinds.draft, tenant, id)).at(-1) as
      ConfigEntry<DraftSpec> | undefined;

  const runsOf = async (tenant: string, id: string) =>
    ((await deps.configEntries.history(kinds.run, tenant, id)) as ConfigEntry<SkillTestRun>[]).map(
      (e) => e.spec,
    );

  const thresholdFor = (tenant: string, definition: Record<string, unknown> | undefined) => {
    const own = (definition?.spec as { testset?: { passThreshold?: unknown } } | undefined)?.testset
      ?.passThreshold;
    if (typeof own === 'number') return own;
    try {
      const value = deps.settings.effective(tenant)['skills.defaultPassThreshold']?.value;
      return typeof value === 'number' ? value : defaultThreshold;
    } catch {
      return defaultThreshold;
    }
  };

  const problemsOf = (definition: Record<string, unknown>) => {
    const validated = validateDefinition(definition, deps.plugins);
    return validated.ok ? [] : validated.errors;
  };

  const normalized = (tenant: string, id: string, input: Record<string, unknown>) => ({
    ...input,
    apiVersion: 'genai/v1',
    kind: 'Skill',
    metadata: { ...(isRecord(input.metadata) ? input.metadata : {}), tenant, id },
  });

  const contentOf = (definition: Record<string, unknown> | SkillDefinition | undefined) => {
    if (!definition) return undefined;
    const metadata = (definition.metadata ?? {}) as Record<string, unknown>;
    return { name: metadata.name ?? null, spec: definition.spec };
  };

  const servicesUsing = async (owner: string, id: string) => {
    const seen = new Set<string>();
    const out: SkillUsage['usedBy'] = [];
    const latest = (await deps.definitions.versions('Skill', owner, id)).at(-1)?.version ?? null;
    for (const compiled of await deps.definitions.capabilities()) {
      const key = `${compiled.service.tenant}/${compiled.service.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const found = await deps.definitions.get(
        'Service',
        compiled.service.tenant,
        compiled.service.id,
      );
      const service = found?.definition as ServiceDefinition | undefined;
      for (const ref of service?.spec.skills ?? []) {
        const parsed = parseSkillRef(ref);
        if (parsed.id !== id) continue;
        const resolved = await resolveSkill(compiled.service.tenant, id, parsed.version);
        if (resolved?.owner !== owner) continue;
        out.push({
          tenant: compiled.service.tenant,
          service: compiled.service.id,
          name: service?.metadata.name ?? compiled.service.id,
          version: parsed.version,
          updateAvailable: latest !== null && parsed.version < latest,
        });
      }
    }
    return { latestVersion: latest, usedBy: out };
  };

  const requirementsFor = (
    tenant: string,
    draft: ConfigEntry<DraftSpec> | undefined,
    runs: SkillTestRun[],
  ): { threshold: number; requirements: SkillRequirement[]; current?: SkillTestRun } => {
    const definition = draft?.spec.definition;
    const threshold = thresholdFor(tenant, definition);
    const current = runs.filter((r) => r.draftRevision === draft?.version).at(-1);
    const cases = (definition?.spec as { testset?: { cases?: unknown } } | undefined)?.testset
      ?.cases;
    const notRun =
      !Array.isArray(cases) || cases.length === 0
        ? ('no_cases' as const)
        : runs.length
          ? ('stale' as const)
          : ('not_run' as const);
    const mustReject = current?.cases.filter((c) => c.type === 'must_reject') ?? [];
    const leaked = mustReject.filter((c) => !c.passed);
    const tools = ((definition?.spec as { tools?: unknown } | undefined)?.tools ?? []) as string[];
    const unpublished = (Array.isArray(tools) ? tools : []).filter(
      (t) => typeof t !== 'string' || !/@\d+(\.\d+)*$/.test(t) || !deps.plugins.tools.has(t),
    );
    return {
      threshold,
      ...(current ? { current } : {}),
      requirements: [
        {
          id: 'tested-on-draft',
          label: t('services.testedOnDraft'),
          met: Boolean(current),
          ...(current ? {} : { detail: t('services.runOnDraft'), reason: notRun }),
        },
        {
          id: 'pass-rate',
          label: t('services.passRate', { percent: percent(threshold) }),
          met: Boolean(current && current.passRate >= threshold),
          threshold,
          ...(current
            ? {
                detail: t('services.passedOf', { passed: current.passed, total: current.total }),
                passedCases: current.passed,
                total: current.total,
              }
            : { detail: t('services.noDraftRun') }),
        },
        {
          id: 'must-reject',
          label: t('services.mustReject'),
          met: Boolean(current) && leaked.length === 0,
          ...(leaked.length
            ? { detail: t('services.notRejected', { count: leaked.length }) }
            : current
              ? {}
              : { detail: t('services.noDraftRun') }),
        },
        {
          id: 'published-tools',
          label: t('services.publishedTools'),
          met: unpublished.length === 0,
          ...(unpublished.length
            ? {
                detail: unpublished.map(String).join(', '),
                unpublishedTools: unpublished.map(String),
              }
            : {}),
        },
      ],
    };
  };

  const publicationOf = async (tenant: string, id: string, version: number) => {
    const entries = (await deps.configEntries.history(
      kinds.publication,
      tenant,
      id,
    )) as ConfigEntry<{ version: number; score: number | null; passed?: number; total?: number }>[];
    const spec = entries.find((e) => e.spec.version === version)?.spec;
    return {
      score: spec?.score ?? null,
      ...(spec?.passed === undefined ? {} : { passed: spec.passed }),
      ...(spec?.total === undefined ? {} : { total: spec.total }),
    };
  };

  const shareView = (entry: ConfigEntry<ShareSpec>): SkillShare => ({
    id: shareId(entry.scope, entry.id),
    tenant: entry.scope,
    skill: entry.spec.skill,
    version: entry.spec.version,
    state: entry.spec.state,
    by: entry.by,
    at: entry.at,
    reason: entry.reason,
    ...(entry.spec.decision ? { decision: entry.spec.decision } : {}),
  });

  const summaryOf = async (viewer: string, owner: string, id: string): Promise<SkillSummary> => {
    const draft = owner === viewer ? await draftOf(owner, id) : undefined;
    const latest = (await deps.definitions.versions('Skill', owner, id)).at(-1);
    const published = latest?.definition as SkillDefinition | undefined;
    const shown = (published ?? draft?.spec.definition) as Record<string, unknown> | undefined;
    const metadata = (shown?.metadata ?? {}) as { name?: string };
    const spec = (shown?.spec ?? {}) as { description?: string };
    const share = await shareOf(owner, id);
    const usage = latest ? await servicesUsing(owner, id) : { usedBy: [] };
    return {
      id,
      owner,
      name: metadata.name ?? id,
      description: spec.description ?? '',
      version: latest?.version ?? null,
      draftRevision: draft?.version ?? null,
      hasChanges: Boolean(
        draft && !sameJson(contentOf(draft.spec.definition), contentOf(published)),
      ),
      status: latest ? 'published' : 'draft',
      share: share?.spec.state ?? 'none',
      sharedWith: new Set(usage.usedBy.map((u) => u.tenant).filter((t) => t !== owner)).size,
      publisher: {
        type: owner === viewer ? 'own' : owner === deps.platformTenant ? 'digdir' : 'shared',
        name: owner,
      },
      usedBy: usage.usedBy.length,
      services: usage.usedBy
        .filter((u) => u.tenant === viewer)
        .map((u) => ({ service: u.service, name: u.name, version: u.version })),
      readOnly: owner !== viewer,
    };
  };

  const detailOf = async (viewer: string, owner: string, id: string): Promise<SkillDetail> => {
    const summary = await summaryOf(viewer, owner, id);
    const own = owner === viewer;
    const draft = own ? await draftOf(owner, id) : undefined;
    const history = await deps.definitions.versions('Skill', owner, id);
    const runs = own ? await runsOf(owner, id) : [];
    const gates = requirementsFor(owner, draft, runs);
    const share = own ? await shareOf(owner, id) : undefined;
    const versions: SkillVersion[] = [];
    for (const v of history)
      versions.push({
        version: v.version,
        publishedAt: v.publishedAt,
        by: v.publishedBy,
        reason: v.reason,
        ...(await publicationOf(owner, id, v.version)),
      });
    const lastTestRun = runs.at(-1) ?? null;
    const shown = (draft?.spec.definition ?? history.at(-1)?.definition) as
      Record<string, unknown> | undefined;
    const attachments = (shown?.spec as { attachments?: unknown } | undefined)?.attachments;
    const attachmentSizes: Record<string, number> = {};
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      const blob = isRecord(attachment) ? attachment.blob : undefined;
      if (typeof blob !== 'string') continue;
      const info = await deps.blobs.head({ tenant: owner, path: blob }).catch(() => undefined);
      if (info) attachmentSizes[blob] = info.size;
    }
    return {
      ...summary,
      draft: draft
        ? {
            revision: draft.version,
            definition: draft.spec.definition,
            by: draft.by,
            at: draft.at,
            reason: draft.reason,
            problems: problemsOf(draft.spec.definition),
            ...(draft.spec.copiedFrom ? { copiedFrom: draft.spec.copiedFrom } : {}),
          }
        : null,
      published: (history.at(-1)?.definition as SkillDefinition | undefined) ?? null,
      versions,
      lastTestRun,
      stale: Boolean(lastTestRun && draft && lastTestRun.draftRevision !== draft.version),
      threshold: gates.threshold,
      requirements: gates.requirements,
      shareRequest: share ? shareView(share) : null,
      attachmentSizes,
    };
  };

  const ownIds = async (tenant: string) => {
    const drafts = (await deps.configEntries.latest({ kind: kinds.draft, scope: tenant }))
      .filter((e) => !e.deleted)
      .map((e) => e.id);
    const published = (await deps.definitions.list(tenant))
      .filter((d) => d.kind === 'Skill')
      .map((d) => d.id);
    return [...new Set([...drafts, ...published])].sort();
  };

  const knownTo = async (viewer: string, owner: string, id: string) => {
    if (owner === viewer) return (await ownIds(viewer)).includes(id);
    return (await shareOf(owner, id))?.spec.state === 'shared';
  };

  const fieldsFor = (expected: Record<string, unknown>) =>
    Object.entries(expected).map(([name, value]) => ({
      name,
      description: name,
      type:
        typeof value === 'number'
          ? ('number' as const)
          : typeof value === 'boolean'
            ? ('boolean' as const)
            : Array.isArray(value)
              ? ('list' as const)
              : ('string' as const),
    }));

  const choice = modelChoice(deps);
  const { familyOf, ephemeralService } = choice;

  const runDraft = async (
    principal: Principal,
    tenant: string,
    definition: unknown,
    parts: DraftInputPart[],
    skill?: RuntimeSkill,
  ): Promise<DraftRunOutcome> => {
    const metadata = (definition as { metadata: { id: string } }).metadata;
    const key = `${tenant}/${metadata.id}`;
    if (skill) pending.set(key, skill);
    try {
      return await deps.drafts.run({
        principal,
        tenant,
        definition,
        parts,
        origin: 'skill-test',
      });
    } finally {
      pending.delete(key);
    }
  };

  const pickModel = (
    usable: Awaited<ReturnType<ModelChoice['usable']>>,
    tenant: string,
    requested: string | undefined,
    needsFields: boolean,
  ) =>
    choice.choose(
      usable.filter((m) => !needsFields || m.capabilities.includes('json-schema')),
      requested,
      choice.settingOf(tenant, 'skills.testModel'),
    );

  const runTestSet = async (
    principal: Principal,
    tenant: string,
    draft: ConfigEntry<DraftSpec>,
    options: { model?: string; judge?: string },
  ): Promise<{ ok: true; run: SkillTestRun } | { ok: false; errors: ValidationError[] }> => {
    const parsed = skillDefinition.safeParse(draft.spec.definition);
    const problems = problemsOf(draft.spec.definition);
    if (!parsed.success || problems.length > 0)
      return {
        ok: false,
        errors: problems.length ? problems : [{ path: '', message: 'the draft is not a skill' }],
      };
    const skill = parsed.data;
    const cases = skill.spec.testset.cases;
    if (cases.length === 0)
      return { ok: false, errors: [{ path: 'spec.testset.cases', message: 'no test cases' }] };
    const usable = await choice.usable(tenant);
    const model = pickModel(
      usable,
      tenant,
      options.model,
      cases.some((c) => c.type === 'fields'),
    );
    if (!model)
      return {
        ok: false,
        errors: [
          {
            path: 'model',
            message: options.model
              ? `model ${options.model} is not available to this tenant`
              : 'no model available',
          },
        ],
      };
    const judge = cases.some((c) => c.type === 'criteria')
      ? choice.pickJudge(usable, tenant, [model], options.judge)
      : undefined;
    if (options.judge && !judge)
      return {
        ok: false,
        errors: [
          {
            path: 'judge',
            message: `model ${options.judge} is not available to this tenant as a judge from another family`,
          },
        ],
      };
    const evalContext: EvalContext = { servedModels: [model], modelFamily: familyOf };
    const runtime = toRuntime(skill, `${skill.metadata.id}@utkast-${draft.version}`);
    const startedAt = new Date().toISOString();
    const results: SkillCaseResult[] = [];
    for (const [index, testCase] of cases.entries()) {
      const fieldsExpected =
        testCase.type === 'fields' && isRecord(testCase.expected) ? testCase.expected : undefined;
      const outcome = await runDraft(
        principal,
        tenant,
        ephemeralService(
          tenant,
          ephemeralId(),
          skill.spec.description,
          'Løs oppgaven i meldingen. Følg ferdigheten under.',
          model,
          fieldsExpected
            ? { kind: 'fields', fields: fieldsFor(fieldsExpected) }
            : { kind: 'answer' },
          testCase.dataset ? { dataset: testCase.dataset } : undefined,
        ),
        [
          { kind: 'text', text: testCase.input },
          ...(testCase.context
            ? [{ kind: 'text' as const, text: `Kilde:\n${testCase.context}` }]
            : []),
        ],
        runtime,
      );
      const base = {
        index,
        input: testCase.input,
        expected: testCase.expected,
        type: testCase.type,
        ...(testCase.context ? { context: testCase.context } : {}),
        ...(testCase.dataset ? { dataset: testCase.dataset } : {}),
      };
      if (!outcome.ok) {
        results.push({
          ...base,
          passed: false,
          answer: '',
          score: null,
          reason: outcome.errors.map((e) => e.message).join('; '),
          ...(outcome.task ? { task: outcome.task } : {}),
          costNok: 0,
        });
        continue;
      }
      const json = outcome.parts.find((p) => p.mime === 'application/json')?.body;
      const fields =
        json?.kind === 'json' && isRecord(json.json)
          ? (json.json as Record<string, unknown>)
          : undefined;
      const observation: Observation = {
        answer: outcome.answer,
        retrieved: [],
        citations: [],
        ...(fields ? { fields } : {}),
      };
      const evalCase = {
        id: `case-${index + 1}`,
        split: 'validation',
        input: testCase.input,
        expected: {
          sources: [],
          ...(fieldsExpected ? { fields: fieldsExpected } : {}),
        },
        grounding: testCase.type === 'must_reject' ? 'refusal-expected' : 'answer-only',
        tags: [],
        needsReview: false,
      } satisfies TestCase;
      let passed = false;
      let score: number | null = null;
      let reason: string | undefined;
      try {
        if (testCase.type === 'criteria') {
          if (!judge)
            throw new Error('Ingen dommermodell fra en annen modellfamilie er tilgjengelig.');
          const criteria =
            typeof testCase.expected === 'string'
              ? testCase.expected
              : JSON.stringify(testCase.expected);
          const scores: Score[] = await rubricJudge(
            choice.judgeModel(principal, tenant, judge, 'skill-test'),
            criteriaJudgePrompt(criteria),
          ).evaluate(evalCase, observation, evalContext);
          const overall = scores.find((s) => s.metric === 'judge.overall');
          score = overall?.value ?? null;
          passed = score === 1;
          const rationale = overall?.details?.rationale;
          if (typeof rationale === 'string') reason = rationale;
        } else {
          const scores = await contractAssertions().evaluate(evalCase, observation, evalContext);
          const metric = testCase.type === 'must_reject' ? 'refusal' : 'fields-match';
          score = scores.find((s) => s.metric === metric)?.value ?? null;
          passed = score === 1;
          if (!passed)
            reason =
              testCase.type === 'must_reject'
                ? 'Svaret avviste ikke forespørselen.'
                : 'Feltene stemmer ikke med det forventede.';
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      results.push({
        ...base,
        passed,
        answer: outcome.answer,
        ...(fields ? { fields } : {}),
        score,
        ...(reason ? { reason } : {}),
        task: outcome.task,
        costNok: outcome.costNok,
      });
    }
    const passedCount = results.filter((r) => r.passed).length;
    const runs = await runsOf(tenant, skill.metadata.id);
    const run: SkillTestRun = {
      id: runs.length + 1,
      skill: skill.metadata.id,
      draftRevision: draft.version,
      startedAt,
      endedAt: new Date().toISOString(),
      by: actorOf(principal.actor ?? principal),
      model,
      judge: judge ?? null,
      passed: passedCount,
      total: results.length,
      passRate: passedCount / results.length,
      threshold: thresholdFor(tenant, draft.spec.definition),
      costNok: results.reduce((sum, r) => sum + r.costNok, 0),
      cases: results,
    };
    await appendVersion(deps.configEntries, {
      kind: kinds.run,
      scope: tenant,
      id: skill.metadata.id,
      spec: run,
      deleted: false,
      by: run.by,
      reason: `Testkjøring av utkast ${draft.version}`,
    });
    return { ok: true, run };
  };

  const toPackage = async (owner: string, definition: SkillDefinition) => {
    const { metadata, spec } = definition;
    const head = {
      name: metadata.id,
      description: spec.description,
      metadata: {
        ...(metadata.name ? { 'display-name': metadata.name } : {}),
        ...(metadata.version ? { version: String(metadata.version) } : {}),
        owner,
        ...(spec.tools.length ? { tools: spec.tools } : {}),
      },
    };
    const encoder = new TextEncoder();
    const folder = metadata.id;
    const entries: ZipEntry[] = [
      {
        name: `${folder}/SKILL.md`,
        data: encoder.encode(`---\n${stringifyYaml(head)}---\n\n${spec.instructions}\n`),
      },
    ];
    if (spec.examples.length)
      entries.push({
        name: `${folder}/examples.yaml`,
        data: encoder.encode(stringifyYaml(spec.examples)),
      });
    if (spec.testset.cases.length || spec.testset.passThreshold !== undefined)
      entries.push({
        name: `${folder}/testset.yaml`,
        data: encoder.encode(stringifyYaml(spec.testset)),
      });
    for (const attachment of spec.attachments) {
      const blob = await deps.blobs.get({ tenant: owner, path: attachment.blob });
      if (blob) entries.push({ name: `${folder}/assets/${attachment.name}`, data: blob.body });
    }
    return storeZip(entries);
  };

  const fromPackage = async (tenant: string, zip: Uint8Array) => {
    const entries = readZip(zip);
    const skillFile = entries
      .filter((e) => /(^|\/)SKILL\.md$/.test(e.name))
      .sort((a, b) => a.name.length - b.name.length)[0];
    if (!skillFile) throw new Error('the package has no SKILL.md');
    const root = skillFile.name.slice(0, skillFile.name.length - 'SKILL.md'.length);
    const decoder = new TextDecoder();
    const file = (name: string) => entries.find((e) => e.name === `${root}${name}`);
    const { head, body } = frontmatter(decoder.decode(skillFile.data));
    if (!isRecord(head)) throw new Error('the SKILL.md frontmatter is not a map');
    const id = String(head.name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63);
    if (!slugPattern.test(id)) throw new Error('the SKILL.md frontmatter needs a name');
    if (!validId(id)) throw new Error(`the skill cannot be called ${id}`);
    const meta = isRecord(head.metadata) ? head.metadata : {};
    const examples = file('examples.yaml');
    const testset = file('testset.yaml');
    const attachments: { name: string; blob: string }[] = [];
    for (const asset of entries.filter((e) => e.name.startsWith(`${root}assets/`))) {
      const name = asset.name.slice(`${root}assets/`.length);
      if (!segmentPattern.test(name)) continue;
      const path = `skills/${id}/${name}`;
      await deps.blobs.put({ tenant, path }, asset.data, contentTypeOf(name));
      attachments.push({ name, blob: path });
    }
    return {
      apiVersion: 'genai/v1',
      kind: 'Skill',
      metadata: {
        tenant,
        id,
        ...(typeof meta['display-name'] === 'string' ? { name: meta['display-name'] } : {}),
      },
      spec: {
        description: String(head.description ?? ''),
        instructions: body,
        examples: examples ? (parseYaml(decoder.decode(examples.data)) as unknown) : [],
        tools: Array.isArray(meta.tools) ? meta.tools : [],
        attachments,
        testset: testset ? (parseYaml(decoder.decode(testset.data)) as unknown) : { cases: [] },
      },
    };
  };

  const mount = <E extends Env, S extends Schema, B extends string>(
    app: Hono<E, S, B>,
    mountDeps: MountDeps,
  ) => {
    const param = (c: Context, name: string) => c.req.param(name) ?? '';
    const problem = (
      c: Context,
      status: 400 | 401 | 403 | 404 | 409 | 422,
      title: string,
      errors: ValidationError[] = [],
    ) =>
      c.json({ type: 'about:blank', title, status, errors }, status, {
        'content-type': 'application/problem+json',
      });
    const body = async (c: Context) => {
      const parsed = (await c.req.json().catch(() => ({}))) as unknown;
      return isRecord(parsed) ? parsed : {};
    };
    const reasonOf = (c: Context) => (changeReasonOf(c) ?? '').trim();
    const ifMatch = (c: Context) => {
      const raw = c.req.header('if-match')?.replace(/"/g, '');
      return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
    };

    const upload = async (c: Context) => {
      const type = c.req.header('content-type') ?? '';
      if (type.startsWith('multipart/form-data')) {
        const file = (await c.req.parseBody()).file;
        return file instanceof File
          ? { name: file.name, data: new Uint8Array(await file.arrayBuffer()) }
          : undefined;
      }
      if (type.startsWith('application/json')) {
        const data = await body(c);
        const name =
          typeof data.name === 'string'
            ? data.name
            : typeof data.fileName === 'string'
              ? data.fileName
              : '';
        return typeof data.contentBase64 === 'string'
          ? { name, data: new Uint8Array(Buffer.from(data.contentBase64, 'base64')) }
          : undefined;
      }
      return { name: c.req.query('name') ?? '', data: new Uint8Array(await c.req.arrayBuffer()) };
    };

    const member = async (c: Context, right?: Right) => {
      const principal = await mountDeps.authenticate(c.req.raw);
      if (!principal) return { response: problem(c, 401, 'Unauthorized') };
      const tenant = param(c, 'tenant');
      const acting = mountDeps.access(principal, tenant, c.req.raw);
      if (!acting) return { response: problem(c, 404, 'Not found') };
      if (principal.kind === 'operator' && !['GET', 'HEAD'].includes(c.req.method))
        return { response: problem(c, 403, 'Support sessions are read-only') };
      if (right) {
        const check = requireRight(acting, tenant, right);
        if (!check.ok) return { response: rightRefused(c, check.problem) };
      }
      return { principal: acting, tenant };
    };

    const ownSkill = async (c: Context, tenant: string) => {
      const id = param(c, 'id');
      return (await ownIds(tenant)).includes(id) ? id : undefined;
    };

    const inTask = async <T>(
      c: Context,
      principal: Principal,
      tenant: string,
      action: SkillAction,
      skill: string,
      reason: string,
      work: () => Promise<T>,
    ) => {
      const done = await mountDeps.admin.within(
        principal,
        action,
        { tenant, reason, skill },
        async () => ({ value: await work(), target: `skill:${skill}` }),
      );
      c.header('genai-task', done.task);
      return done.value;
    };

    const appendDraft = (
      principal: Principal,
      tenant: string,
      id: string,
      spec: DraftSpec,
      reason: string,
      ifVersion?: number,
    ) =>
      appendVersion(deps.configEntries, {
        kind: kinds.draft,
        scope: tenant,
        id,
        spec,
        deleted: false,
        by: actorOf(principal.actor ?? principal),
        reason,
        ...(ifVersion === undefined ? {} : { ifVersion }),
      });

    const saveDraft = (
      c: Context,
      action: SkillAction,
      principal: Principal,
      tenant: string,
      id: string,
      spec: DraftSpec,
      reason: string,
      ifVersion?: number,
    ) =>
      inTask(c, principal, tenant, action, id, reason, () =>
        appendDraft(principal, tenant, id, spec, reason, ifVersion),
      );

    const recordShare = async (
      c: Context,
      action: SkillAction,
      principal: Principal,
      tenant: string,
      skill: string,
      spec: ShareSpec,
      reason: string,
    ) =>
      inTask(c, principal, tenant, action, skill, reason, () =>
        appendVersion(deps.configEntries, {
          kind: kinds.share,
          scope: tenant,
          id: skill,
          spec,
          deleted: false,
          by: actorOf(principal.actor ?? principal),
          reason,
        }),
      );

    app.get('/tenants/:tenant/skills', async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      const { tenant } = guard;
      const own = await Promise.all(
        (await ownIds(tenant)).map((id) => summaryOf(tenant, tenant, id)),
      );
      const others = await Promise.all(
        (await shares())
          .filter((e) => e.spec.state === 'shared' && e.scope !== tenant)
          .map((e) => summaryOf(tenant, e.scope, e.id)),
      );
      return c.json({ data: [...own, ...others] });
    });

    app.post('/tenants/:tenant/skills', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const data = await body(c);
      const input = isRecord(data.definition) ? data.definition : {};
      const id = String(
        typeof data.id === 'string'
          ? data.id
          : isRecord(input.metadata)
            ? (input.metadata.id ?? '')
            : '',
      );
      if (!validId(id)) return problem(c, 422, 'Invalid skill', [invalidId]);
      if ((await ownIds(tenant)).includes(id))
        return problem(c, 409, 'Conflict', [{ path: 'id', message: `skill ${id} exists` }]);
      const definition = normalized(tenant, id, {
        spec: {
          description: '',
          instructions: '',
          examples: [],
          tools: [],
          attachments: [],
          testset: { cases: [] },
        },
        ...input,
        ...(typeof data.name === 'string' ? { metadata: { name: data.name } } : {}),
      });
      await saveDraft(
        c,
        'platform.skill.create',
        principal,
        tenant,
        id,
        { definition },
        reasonOf(c),
      );
      return c.json(await detailOf(tenant, tenant, id), 201);
    });

    app.post('/tenants/:tenant/skills/import', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const file = await upload(c);
      if (!file) return problem(c, 400, 'Invalid request', [{ path: 'file', message: 'no file' }]);
      const zip = file.data;
      let definition: Record<string, unknown>;
      try {
        definition = await fromPackage(tenant, zip);
      } catch (error) {
        return problem(c, 422, 'Invalid package', [
          { path: 'file', message: error instanceof Error ? error.message : String(error) },
        ]);
      }
      const id = (definition.metadata as { id: string }).id;
      if ((await ownIds(tenant)).includes(id))
        return problem(c, 409, 'Conflict', [{ path: 'id', message: `skill ${id} exists` }]);
      await saveDraft(
        c,
        'platform.skill.import',
        principal,
        tenant,
        id,
        { definition },
        reasonOf(c),
      );
      return c.json(await detailOf(tenant, tenant, id), 201);
    });

    app.get('/tenants/:tenant/skills/:id', async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      const owner = c.req.query('owner') ?? guard.tenant;
      const id = param(c, 'id');
      if (!(await knownTo(guard.tenant, owner, id))) return problem(c, 404, 'Not found');
      return c.json(await detailOf(guard.tenant, owner, id));
    });

    app.put('/tenants/:tenant/skills/:id', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      if (!id) return problem(c, 404, 'Not found');
      const data = await body(c);
      if (!isRecord(data.definition))
        return problem(c, 400, 'Invalid request', [
          { path: 'definition', message: 'a definition is required' },
        ]);
      const current = await draftOf(tenant, id);
      try {
        await saveDraft(
          c,
          'platform.skill.draft.save',
          principal,
          tenant,
          id,
          {
            definition: normalized(tenant, id, data.definition),
            ...(current?.spec.copiedFrom ? { copiedFrom: current.spec.copiedFrom } : {}),
          },
          reasonOf(c),
          ifMatch(c),
        );
      } catch (error) {
        if (error instanceof VersionConflict)
          return problem(c, 409, 'Conflict', [{ path: 'if-match', message: error.message }]);
        throw error;
      }
      return c.json(await detailOf(tenant, tenant, id));
    });

    app.get('/tenants/:tenant/skills/:id/versions', async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      const owner = c.req.query('owner') ?? guard.tenant;
      const id = param(c, 'id');
      if (!(await knownTo(guard.tenant, owner, id))) return problem(c, 404, 'Not found');
      return c.json({ data: (await detailOf(guard.tenant, owner, id)).versions });
    });

    app.get('/tenants/:tenant/skills/:id/usage', async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      const owner = c.req.query('owner') ?? guard.tenant;
      const id = param(c, 'id');
      if (!(await knownTo(guard.tenant, owner, id))) return problem(c, 404, 'Not found');
      const usage = await servicesUsing(owner, id);
      const visible =
        owner === guard.tenant
          ? usage
          : { ...usage, usedBy: usage.usedBy.filter((u) => u.tenant === guard.tenant) };
      return c.json(visible satisfies SkillUsage);
    });

    app.get('/tenants/:tenant/skills/:id/test-runs', async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      const id = await ownSkill(c, guard.tenant);
      if (!id) return problem(c, 404, 'Not found');
      return c.json({ data: (await runsOf(guard.tenant, id)).reverse() });
    });

    app.post('/tenants/:tenant/skills/:id/test-runs', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      const draft = id ? await draftOf(tenant, id) : undefined;
      if (!draft) return problem(c, 404, 'Not found');
      const data = await body(c);
      const result = await runTestSet(principal, tenant, draft, {
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
        ...(typeof data.judge === 'string' ? { judge: data.judge } : {}),
      });
      if (!result.ok) return problem(c, 422, 'The test set cannot run', result.errors);
      return c.json(result.run);
    });

    app.delete('/tenants/:tenant/skills/:id/testcases/:index', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      const draft = id ? await draftOf(tenant, id) : undefined;
      if (!id || !draft) return problem(c, 404, 'Fant ikke');
      const index = Number(param(c, 'index'));
      const definition = structuredClone(draft.spec.definition);
      const cases = casesOf(definition);
      if (!Number.isInteger(index) || index < 0 || index >= cases.length)
        return problem(c, 404, 'Fant ikke testtilfellet', [
          { path: 'index', message: 'no such test case' },
        ]);
      cases.splice(index, 1);
      try {
        await saveDraft(
          c,
          'platform.skill.testcase.delete',
          principal,
          tenant,
          id,
          { ...draft.spec, definition },
          reasonOf(c),
          ifMatch(c) ?? draft.version,
        );
      } catch (error) {
        if (error instanceof VersionConflict)
          return problem(c, 409, 'Utkastet er endret av noen andre', [
            { path: 'if-match', message: error.message },
          ]);
        throw error;
      }
      return c.json(await detailOf(tenant, tenant, id));
    });

    app.post('/tenants/:tenant/skills/:id/fix', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      const draft = id ? await draftOf(tenant, id) : undefined;
      if (!id || !draft) return problem(c, 404, 'Fant ikke');
      const spec = (draft.spec.definition.spec ?? {}) as Record<string, unknown>;
      const before = typeof spec.instructions === 'string' ? spec.instructions : '';
      const last = (await runsOf(tenant, id)).at(-1);
      const failures = (last?.cases ?? []).filter((r) => !r.passed);
      if (!last || failures.length === 0)
        return problem(c, 409, 'Ingen feilede testtilfeller å rette', [
          { path: 'testRun', message: 'run the test set and fix only when cases fail' },
        ]);
      const optimiser = await platformService(deps, optimiserServiceId);
      if (!optimiser)
        return problem(c, 409, t('services.optimiserNotPublished'), [
          { path: 'optimiser', message: t('services.optimiserNotPublished') },
        ]);
      const usable = (await choice.usable(tenant)).filter((m) => runsPlatformServices(deps, m.id));
      const model = choice.choose(
        usable,
        undefined,
        choice.settingOf(tenant, 'assistant.model') ?? defaultModelOf(optimiser),
      );
      if (!model)
        return problem(c, 409, 'Ingen modell er tilgjengelig', [
          { path: 'model', message: 'no model available' },
        ]);
      const evidence = {
        purpose: typeof spec.description === 'string' ? spec.description : '',
        instructions: before,
        feedback: [],
        failures: failures.map((r) => ({
          input: r.input,
          expected: typeof r.expected === 'string' ? r.expected : JSON.stringify(r.expected),
          output: r.answer,
          ...(r.reason ? { reason: r.reason } : {}),
        })),
      };
      let change: { after: string; reasons: string[] } | undefined;
      try {
        const outcome = await runPlatformService(deps, {
          principal,
          tenant,
          service: optimiserServiceId,
          model,
          data: { evidence },
        });
        if (!outcome?.ok) throw new Error(outcome?.errors.map((e) => e.message).join('; '));
        const part = outcome.parts.find((p) => p.mime === optimiserResultMime);
        const result = part?.body.kind === 'json' ? (part.body.json as OptimiserResult) : undefined;
        change =
          result?.changed && result.instructions
            ? { after: result.instructions, reasons: result.reasons }
            : undefined;
      } catch (error) {
        return problem(c, 422, 'Assistenten svarte ikke', [
          { path: 'model', message: error instanceof Error ? error.message : String(error) },
        ]);
      }
      if (!change)
        return problem(c, 422, 'Assistenten foreslo ingen endring', [
          { path: 'instructions', message: 'no change proposed' },
        ]);
      const fixId = ephemeralId('fix');
      const fix: SkillFix = {
        id: fixId,
        fixId,
        skill: id,
        draftRevision: draft.version,
        before,
        after: change.after,
        reasons: change.reasons,
        status: 'proposed',
      };
      const proposed = 'Forslag til retting av instruksjonene';
      await inTask(c, principal, tenant, 'platform.skill.fix.propose', id, proposed, () =>
        appendVersion(deps.configEntries, {
          kind: kinds.fix,
          scope: tenant,
          id: fix.id,
          spec: fix,
          deleted: false,
          by: actorOf(principal.actor ?? principal),
          reason: proposed,
        }),
      );
      return c.json(fix, 201);
    });

    app.post('/tenants/:tenant/skills/:id/fix/:fixId/apply', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      const draft = id ? await draftOf(tenant, id) : undefined;
      const found = (await deps.configEntries.history(kinds.fix, tenant, param(c, 'fixId'))).at(
        -1,
      ) as ConfigEntry<SkillFix> | undefined;
      if (!id || !draft || !found || found.spec.skill !== id) return problem(c, 404, 'Fant ikke');
      const fix = found.spec;
      if (fix.status !== 'proposed' || fix.draftRevision !== draft.version)
        return problem(c, 409, 'Utkastet er endret siden forslaget ble laget', [
          { path: 'draftRevision', message: `the draft is at revision ${draft.version}` },
        ]);
      const definition = structuredClone(draft.spec.definition);
      definition.spec = {
        ...(definition.spec as Record<string, unknown>),
        instructions: fix.after,
      };
      const reason = reasonOf(c);
      await inTask(c, principal, tenant, 'platform.skill.fix.apply', id, reason, async () => {
        await appendDraft(
          principal,
          tenant,
          id,
          { ...draft.spec, definition },
          reason,
          draft.version,
        );
        await appendVersion(deps.configEntries, {
          kind: kinds.fix,
          scope: tenant,
          id: fix.id,
          spec: { ...fix, status: 'applied' },
          deleted: false,
          by: actorOf(principal.actor ?? principal),
          reason,
        });
      });
      return c.json(await detailOf(tenant, tenant, id));
    });

    app.get('/tenants/:tenant/skills/:id/requirements', async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      const id = await ownSkill(c, guard.tenant);
      if (!id) return problem(c, 404, 'Not found');
      const gates = requirementsFor(
        guard.tenant,
        await draftOf(guard.tenant, id),
        await runsOf(guard.tenant, id),
      );
      return c.json({ threshold: gates.threshold, requirements: gates.requirements });
    });

    app.post('/tenants/:tenant/skills/:id/publish', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      const draft = id ? await draftOf(tenant, id) : undefined;
      if (!id || !draft) return problem(c, 404, 'Not found');
      const reason = reasonOf(c);
      if (!isReasonLongEnough(reason))
        return problem(c, 400, 'Invalid request', [
          { path: 'change-reason', message: reasonTooShort },
        ]);
      const latest = (await deps.definitions.versions('Skill', tenant, id)).at(-1);
      if (latest && sameJson(contentOf(draft.spec.definition), contentOf(latest.definition)))
        return problem(c, 409, 'Ingen endringer å publisere');
      const gates = requirementsFor(tenant, draft, await runsOf(tenant, id));
      if (gates.requirements.some((r) => !r.met))
        return c.json(
          {
            type: 'about:blank',
            title: 'Ferdigheten oppfyller ikke kravene for publisering',
            status: 422,
            ok: false,
            requirements: gates.requirements,
          } satisfies SkillPublishResult & { type: string; title: string; status: number },
          422,
          { 'content-type': 'application/problem+json' },
        );
      const published = await mountDeps.admin.publish(principal, {
        definition: draft.spec.definition,
        files: {},
        reason,
      });
      if (!published.ok) return problem(c, 422, 'The skill cannot be published', published.errors);
      await appendVersion(deps.configEntries, {
        kind: kinds.publication,
        scope: tenant,
        id,
        spec: {
          version: published.value.version,
          score: gates.current?.passRate ?? null,
          ...(gates.current ? { passed: gates.current.passed, total: gates.current.total } : {}),
        },
        deleted: false,
        by: actorOf(principal.actor ?? principal),
        reason,
      });
      return c.json({
        ok: true,
        version: published.value.version,
        publishedAt: published.value.publishedAt,
        task: published.task,
        requirements: gates.requirements,
      } satisfies SkillPublishResult);
    });

    app.post('/tenants/:tenant/skills/:id/share', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      if (!id) return problem(c, 404, 'Not found');
      const data = await body(c);
      const reason = reasonOf(c);
      if (data.confirm !== true)
        return problem(c, 422, 'Bekreft at ferdigheten ikke inneholder personopplysninger', [
          { path: 'confirm', message: 'confirm that the skill has no personal or exempt data' },
        ]);
      if (!isReasonLongEnough(reason))
        return problem(c, 400, 'Invalid request', [
          { path: 'change-reason', message: reasonTooShort },
        ]);
      const latest = (await deps.definitions.versions('Skill', tenant, id)).at(-1);
      if (!latest)
        return problem(c, 422, 'Publiser ferdigheten før du deler den', [
          { path: 'version', message: 'the skill has no published version' },
        ]);
      const current = await shareOf(tenant, id);
      if (current?.spec.state === 'pending_digdir' || current?.spec.state === 'shared')
        return problem(c, 409, 'Conflict', [
          { path: 'share', message: `the skill is already ${current.spec.state}` },
        ]);
      const saved = await recordShare(
        c,
        'platform.skill.share.request',
        principal,
        tenant,
        id,
        {
          skill: id,
          version: latest.version,
          state: 'pending_digdir',
          ...byNameOf(c),
        },
        reason,
      );
      return c.json(shareView(saved), 202);
    });

    app.delete('/tenants/:tenant/skills/:id/share', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      const current = id ? await shareOf(tenant, id) : undefined;
      if (!id || !current || current.spec.state === 'none' || current.spec.state === 'rejected')
        return problem(c, 404, 'Not found');
      const saved = await recordShare(
        c,
        'platform.skill.share.withdraw',
        principal,
        tenant,
        id,
        { skill: id, version: current.spec.version, state: 'none' },
        reasonOf(c),
      );
      await deps.sync();
      return c.json(shareView(saved));
    });

    app.post('/tenants/:tenant/skills/:id/copy', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const data = await body(c);
      const source = param(c, 'id');
      const owner = typeof data.owner === 'string' ? data.owner : tenant;
      if (!(await knownTo(tenant, owner, source))) return problem(c, 404, 'Not found');
      const version =
        typeof data.version === 'number'
          ? data.version
          : (await deps.definitions.versions('Skill', owner, source)).at(-1)?.version;
      const found =
        version === undefined
          ? undefined
          : await deps.definitions.get('Skill', owner, source, version);
      if (!found || version === undefined)
        return problem(c, 404, 'Not found', [{ path: 'version', message: 'no published version' }]);
      const id = typeof data.id === 'string' ? data.id : source;
      if (!validId(id)) return problem(c, 422, 'Invalid skill', [invalidId]);
      if ((await ownIds(tenant)).includes(id))
        return problem(c, 409, 'Conflict', [{ path: 'id', message: `skill ${id} exists` }]);
      const original = found.definition as SkillDefinition;
      const reason = reasonOf(c);
      await inTask(c, principal, tenant, 'platform.skill.copy', id, reason, async () => {
        const attachments: { name: string; blob: string }[] = [];
        for (const attachment of original.spec.attachments) {
          if (owner === tenant) {
            attachments.push(attachment);
            continue;
          }
          const blob = await deps.blobs.get({ tenant: owner, path: attachment.blob });
          if (!blob) continue;
          const path = `skills/${id}/${attachment.name}`;
          await deps.blobs.put({ tenant, path }, blob.body, blob.info.contentType);
          attachments.push({ name: attachment.name, blob: path });
        }
        const definition = normalized(tenant, id, {
          ...original,
          metadata: original.metadata.name ? { name: original.metadata.name } : {},
          spec: { ...original.spec, attachments },
        });
        await appendDraft(
          principal,
          tenant,
          id,
          { definition, copiedFrom: { owner, id: source, version } },
          reason,
        );
      });
      return c.json(await detailOf(tenant, tenant, id), 201);
    });

    app.get('/tenants/:tenant/skills/:id/export', async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      const owner = c.req.query('owner') ?? guard.tenant;
      const id = param(c, 'id');
      if (!(await knownTo(guard.tenant, owner, id))) return problem(c, 404, 'Not found');
      const requested = c.req.query('version');
      let definition: unknown;
      if (requested !== undefined)
        definition = (await deps.definitions.get('Skill', owner, id, Number(requested)))
          ?.definition;
      else if (owner === guard.tenant)
        definition =
          (await draftOf(owner, id))?.spec.definition ??
          (await deps.definitions.get('Skill', owner, id))?.definition;
      else definition = (await deps.definitions.get('Skill', owner, id))?.definition;
      const parsed = skillDefinition.safeParse(definition);
      if (!parsed.success)
        return problem(c, 422, 'The skill cannot be exported', [
          { path: 'definition', message: 'the skill is not complete' },
        ]);
      const zip = await toPackage(owner, parsed.data);
      const accept = c.req.header('accept') ?? '';
      if (accept.includes('application/json') && !/application\/zip|\*\/\*/.test(accept))
        return c.json({
          fileName: `${id}.zip`,
          contentBase64: Buffer.from(zip).toString('base64'),
        });
      return c.body(zip.slice().buffer, 200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${id}.zip"`,
      });
    });

    app.post('/tenants/:tenant/skills/:id/attachments', async (c) => {
      const guard = await member(c, 'manage-services');
      if (guard.response) return guard.response;
      const { tenant, principal } = guard;
      const id = await ownSkill(c, tenant);
      if (!id) return problem(c, 404, 'Not found');
      const file = await upload(c);
      if (!file) return problem(c, 400, 'Invalid request', [{ path: 'file', message: 'no file' }]);
      const segment = file.name
        .replace(/[^A-Za-z0-9æøåÆØÅ._-]+/g, '-')
        .replace(/^[^A-Za-z0-9æøåÆØÅ]+/, '');
      if (!file.name.trim() || !segmentPattern.test(segment))
        return problem(c, 422, 'Invalid attachment', [
          { path: 'name', message: 'the file needs a name' },
        ]);
      if (file.data.byteLength > maxZipBytes)
        return problem(c, 422, 'Invalid attachment', [
          { path: 'file', message: 'the file is too large' },
        ]);
      const path = `skills/${id}/${segment}`;
      try {
        const info = await inTask(
          c,
          principal,
          tenant,
          'platform.skill.attachment.upload',
          id,
          reasonOf(c),
          () => deps.blobs.put({ tenant, path }, file.data, contentTypeOf(file.name)),
        );
        return c.json(
          { name: file.name, blob: path, size: info.size } satisfies SkillAttachmentUpload,
          201,
        );
      } catch (error) {
        if (error instanceof BlobError)
          return problem(c, 422, 'Invalid attachment', [{ path: 'file', message: error.message }]);
        throw error;
      }
    });

    app.get('/tenants/:tenant/skill-tools', async (c) => {
      const guard = await member(c);
      if (guard.response) return guard.response;
      const owners = [...new Set([guard.tenant, deps.platformTenant])];
      const states = (await Promise.all(owners.map((o) => deps.connections.list(o)))).flat();
      const versions = new Map<string, Set<string>>();
      for (const state of states)
        for (const tool of state.tools)
          versions.set(
            tool.name,
            (versions.get(tool.name) ?? new Set()).add(state.connection.version),
          );
      const data: SkillToolOption[] = [...versions]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, list]) => ({
          id,
          name: id,
          versions: [...list].sort((a, b) => compareVersions(b, a)),
        }));
      return c.json({ data });
    });

    app.get('/operator/skills/shares', async (c) => {
      const principal = await mountDeps.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Unauthorized');
      if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
      const state = c.req.query('state');
      const names = await mountDeps.admin.tenantNames();
      const listed = (await shares()).filter((e) => !state || e.spec.state === state);
      const data = await Promise.all(
        listed.map(async (entry) => ({
          ...shareView(entry),
          ...(entry.spec.byName ? { byName: entry.spec.byName } : {}),
          tenantName: names.get(entry.scope) ?? entry.scope,
          skillName: await skillNameOf(entry.scope, entry.spec.skill, entry.spec.version),
          detail: await shareDetailOf(entry),
        })),
      );
      return c.json({ data });
    });

    app.post('/operator/skills/shares/:id/decision', async (c) => {
      const principal = await mountDeps.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Unauthorized');
      if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
      const { tenant, skill } = splitShareId(param(c, 'id'));
      const current = await shareOf(tenant, skill);
      if (!current || current.spec.state !== 'pending_digdir') return problem(c, 404, 'Not found');
      const data = await body(c);
      const reason = reasonOf(c);
      if (typeof data.approve !== 'boolean' || !isReasonLongEnough(reason))
        return problem(c, 400, 'Invalid request', [
          { path: 'approve', message: 'approve (true or false) and a reason are required' },
        ]);
      const result = await mountDeps.admin.perform<ConfigEntry<ShareSpec>>(
        { ...principal, tenant: deps.platformTenant },
        'platform.skill.share.decide',
        {
          tenant: deps.platformTenant,
          reason,
          owner: tenant,
          skill,
          approve: data.approve,
          byName: actorNameOf(c),
        },
      );
      c.header('genai-task', result.task);
      if (!result.ok) return problem(c, 409, 'Conflict', result.errors);
      await deps.sync();
      return c.json(shareView(result.value));
    });
  };

  const shareDetailOf = async (entry: ConfigEntry<ShareSpec>) => {
    const { skill, version } = entry.spec;
    const specOf = async (v: number) =>
      (
        (await deps.definitions.get('Skill', entry.scope, skill, v))?.definition as
          SkillDefinition | undefined
      )?.spec;
    const spec = await specOf(version);
    const previous = (await deps.configEntries.history(kinds.share, entry.scope, skill))
      .map((e) => e.spec as ShareSpec)
      .filter((s) => s.state === 'shared' && s.version < version)
      .at(-1);
    const before = previous ? await specOf(previous.version) : undefined;
    const test = await publicationOf(entry.scope, skill, version);
    return {
      description: spec?.description ?? '',
      instructions: spec?.instructions ?? '',
      tools: spec?.tools ?? [],
      test: { ...test, threshold: spec?.testset.passThreshold ?? defaultThreshold },
      ...(previous && before
        ? { previous: { version: previous.version, instructions: before.instructions } }
        : {}),
    };
  };

  const skillNameOf = async (tenant: string, skill: string, version: number) => {
    const found = await deps.definitions.get('Skill', tenant, skill, version);
    const metadata = (found?.definition as { metadata?: { name?: string } } | undefined)?.metadata;
    return metadata?.name ?? skill;
  };

  const handlers: Record<string, AdminHandler> = {
    ...Object.fromEntries(skillActions.map((action) => [action, routeOnly])),
    'platform.skill.share.decide': async (input, principal) => {
      const owner = String(input.owner ?? '');
      const skill = String(input.skill ?? '');
      const target = `skill-share:${owner}/${skill}`;
      if (principal.kind !== 'operator')
        return {
          ok: false,
          errors: [{ path: 'principal', message: 'only operators decide skill shares' }],
          target,
        };
      const current = await shareOf(owner, skill);
      if (!current || current.spec.state !== 'pending_digdir')
        return {
          ok: false,
          errors: [{ path: 'share', message: `no pending share of ${skill}` }],
          target,
        };
      const approved = input.approve === true;
      const by = actorOf(principal);
      const saved = await appendVersion<ShareSpec>(deps.configEntries, {
        kind: kinds.share,
        scope: owner,
        id: skill,
        spec: {
          skill,
          version: current.spec.version,
          state: approved ? 'shared' : 'rejected',
          decision: {
            approved,
            by,
            ...(typeof input.byName === 'string' && input.byName ? { byName: input.byName } : {}),
            at: new Date().toISOString(),
            reason: input.reason,
          },
        },
        deleted: false,
        by,
        reason: input.reason,
      });
      return {
        ok: true,
        value: saved,
        target,
        audit: { scope: 'platform', tenant: owner, after: { state: saved.spec.state } },
      };
    },
  };

  return { id: 'skills', handlers, mount, decorateCapability };
};
