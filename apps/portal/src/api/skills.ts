import type { ApiContext } from '../api';

export type SkillCaseType = 'criteria' | 'fields' | 'must_reject';

export interface SkillExample {
  input: string;
  expectedOutput: string;
}

export interface SkillAttachment {
  name: string;
  blob: string;
}

export interface SkillCase {
  input: string;
  expected: string | Record<string, unknown>;
  type: SkillCaseType;
  context?: string;
  dataset?: string;
}

export interface SkillFix {
  fixId: string;
  before: string;
  after: string;
}

export interface SkillSpec {
  description: string;
  instructions: string;
  examples: SkillExample[];
  tools: string[];
  attachments: SkillAttachment[];
  testset: { passThreshold?: number; cases: SkillCase[] };
}

export interface SkillDefinition {
  apiVersion: 'genai/v1';
  kind: 'Skill';
  metadata: { tenant: string; id: string; name?: string; version?: number };
  spec: SkillSpec;
}

export type SkillAssistantIntent =
  'suggest-description' | 'suggest-instructions' | 'suggest-examples' | 'fix-instructions';

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

export interface SkillAssistantProposal {
  id: string;
  level: 1 | 2 | 3 | 4;
  kind: 'change' | 'connector' | 'building_block' | 'platform_change';
  title: string;
  detail: string;
  section?: string;
  patch?: JsonPatchOp[];
  after?: SkillDefinition;
  validation: { ok: boolean; errors?: { path: string; message: string }[] };
  requiresApproval: boolean;
  appliedToDraft: false;
  storedProposalId?: string;
}

export interface SkillAssistantRejection {
  attempted: string;
  reason: string;
  code: string;
}

export interface SkillAssistantTurn {
  turnId: string;
  status: 'completed' | 'refused' | 'unavailable' | 'budget_exhausted';
  message: string;
  proposals: SkillAssistantProposal[];
  rejected?: SkillAssistantRejection[];
  policy?: { rule: string; ownedBy: string; link?: string; alternative?: string };
  usage: { tokens: number; budgetLeftToday: number; dailyBudget: number };
}

export interface SkillAssistantRequest {
  message: string;
  draft: { definition: SkillDefinition | string };
  intent: SkillAssistantIntent;
}

export type SkillStatus = 'draft' | 'published';
export type SkillShare = 'none' | 'pending_digdir' | 'shared' | 'rejected';
export type SkillRequirementId =
  'tested-on-draft' | 'pass-rate' | 'must-reject' | 'published-tools';

export interface SkillPublisher {
  type: 'digdir' | 'own' | 'shared';
  name: string;
}

export interface SkillUse {
  service: string;
  name: string;
  version: number;
}

export interface SkillSummaryResponse {
  id: string;
  owner: string;
  name: string;
  description: string;
  version: number | null;
  draftRevision: number | null;
  hasChanges: boolean;
  status: SkillStatus;
  share: SkillShare;
  sharedWith: number;
  publisher: SkillPublisher;
  usedBy: number;
  services: SkillUse[];
  readOnly: boolean;
}

export interface SkillProblem {
  path: string;
  message: string;
}

export interface SkillDraftResponse {
  revision: number;
  definition: SkillDefinition;
  by: string;
  at: string;
  reason: string;
  problems: SkillProblem[];
  copiedFrom?: { owner: string; id: string; version: number };
}

export interface SkillVersionResponse {
  version: number;
  publishedAt: string;
  by: string;
  reason: string;
  score: number | null;
  passed?: number;
  total?: number;
}

export interface SkillCaseResultResponse {
  index: number;
  input: string;
  expected: string | Record<string, unknown>;
  type: SkillCaseType;
  passed: boolean;
  answer: string;
  fields?: Record<string, unknown>;
  score: number | null;
  reason?: string;
  task?: string;
  costNok: number;
}

export interface SkillTestRunResponse {
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
  cases: SkillCaseResultResponse[];
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

export interface SkillShareResponse {
  id: string;
  tenant: string;
  skill: string;
  version: number;
  state: SkillShare;
  by: string;
  at: string;
  reason: string;
  decision?: { approved: boolean; by: string; at: string; reason: string };
}

export interface SkillDetailResponse extends SkillSummaryResponse {
  draft: SkillDraftResponse | null;
  published: SkillDefinition | null;
  versions: SkillVersionResponse[];
  lastTestRun: SkillTestRunResponse | null;
  stale: boolean;
  threshold: number;
  requirements: SkillRequirement[];
  shareRequest: SkillShareResponse | null;
  attachmentSizes: Record<string, number>;
}

export interface SkillUsageResponse {
  latestVersion: number | null;
  usedBy: {
    tenant: string;
    service: string;
    name: string;
    version: number;
    updateAvailable: boolean;
  }[];
}

export interface SkillRequirementsResponse {
  threshold: number;
  requirements: SkillRequirement[];
}

export interface SkillPublishResponse {
  ok: boolean;
  version?: number;
  publishedAt?: string;
  task?: string;
  requirements: SkillRequirement[];
}

export interface SkillPackageResponse {
  fileName: string;
  contentBase64: string;
}

export interface SkillToolOption {
  id: string;
  name: string;
  versions: string[];
}

export interface UploadedAttachment extends SkillAttachment {
  size: number;
}

export interface SkillSummary {
  id: string;
  owner: string;
  name: string;
  description: string;
  publisher: SkillPublisher;
  status: SkillStatus;
  share: SkillShare;
  version?: number;
  draftVersion: number;
  draftChanged: boolean;
  usedBy: SkillUse[];
}

export interface SkillDraft {
  definition: SkillDefinition;
  revision: number;
}

export interface SkillCaseResult {
  case: number;
  passed: boolean;
  reason?: string;
}

export interface SkillTestRun {
  id: number;
  revision: number;
  at: string;
  passed: number;
  total: number;
  results: SkillCaseResult[];
}

export interface SkillShareRequest {
  by: string;
  at: string;
  reason: string;
}

export interface SkillDetail extends SkillSummary {
  editable: boolean;
  draft: SkillDraft;
  published?: SkillDefinition;
  passThreshold: number;
  lastTestRun?: SkillTestRun;
  shareRequest?: SkillShareRequest;
  sharedWith: number;
  attachmentSizes: Record<string, number>;
}

export interface SkillVersion {
  version: number;
  publishedAt: string;
  by: string;
  reason?: string;
  current: boolean;
  shared: boolean;
  score?: { passed: number; total: number };
  testedBy?: string;
}

export interface SkillUsage {
  services: SkillUse[];
  sharedWith: number;
}

export type SkillGateKind = 'test_run_on_draft' | 'pass_rate' | 'must_reject' | 'published_tools';

export interface SkillGate {
  kind: SkillGateKind;
  passed: boolean;
  reason?: 'no_cases' | 'not_run' | 'stale';
  passedCases?: number;
  total?: number;
  threshold?: number;
  unpublishedTools?: string[];
}

export interface SkillPublishCheck {
  threshold: number;
  blocked: boolean;
  gates: SkillGate[];
}

export interface SkillPackage {
  fileName: string;
  blob: Blob;
}

const gateKinds: Record<SkillRequirementId, SkillGateKind> = {
  'tested-on-draft': 'test_run_on_draft',
  'pass-rate': 'pass_rate',
  'must-reject': 'must_reject',
  'published-tools': 'published_tools',
};

export const reservedSkillIds = ['import', 'imports'];

export const skillSlug = (name: string) => {
  const slug = name
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  if (!slug) return 'ny-ferdighet';
  return reservedSkillIds.includes(slug) ? `${slug}-ferdighet` : slug;
};

const blankSpec = (): SkillSpec => ({
  description: '',
  instructions: '',
  examples: [],
  tools: [],
  attachments: [],
  testset: { cases: [] },
});

const complete = (definition: SkillDefinition): SkillDefinition => {
  const spec: Partial<SkillSpec> = definition.spec ?? {};
  return {
    ...definition,
    spec: {
      ...blankSpec(),
      ...spec,
      testset: { ...spec.testset, cases: spec.testset?.cases ?? [] },
    },
  };
};

export const toSummary = (s: SkillSummaryResponse): SkillSummary => ({
  id: s.id,
  owner: s.owner,
  name: s.name,
  description: s.description,
  publisher: s.publisher,
  status: s.status,
  share: s.share,
  ...(s.version === null ? {} : { version: s.version }),
  draftVersion: (s.version ?? 0) + 1,
  draftChanged: s.hasChanges,
  usedBy: s.services,
});

export const toTestRun = (run: SkillTestRunResponse): SkillTestRun => ({
  id: run.id,
  revision: run.draftRevision,
  at: run.endedAt,
  passed: run.passed,
  total: run.total,
  results: run.cases.map((c) => ({
    case: c.index,
    passed: c.passed,
    ...(c.reason ? { reason: c.reason } : {}),
  })),
});

export const toDetail = (d: SkillDetailResponse): SkillDetail => {
  const published = d.published ? complete(d.published) : undefined;
  const definition = d.draft
    ? complete(d.draft.definition)
    : (published ??
      complete({
        apiVersion: 'genai/v1',
        kind: 'Skill',
        metadata: { tenant: d.owner, id: d.id, name: d.name },
        spec: blankSpec(),
      }));
  return {
    ...toSummary(d),
    editable: !d.readOnly,
    draft: { definition, revision: d.draft?.revision ?? 0 },
    ...(published ? { published } : {}),
    passThreshold: d.threshold,
    ...(d.lastTestRun ? { lastTestRun: toTestRun(d.lastTestRun) } : {}),
    ...(d.shareRequest
      ? {
          shareRequest: {
            by: d.shareRequest.by,
            at: d.shareRequest.at,
            reason: d.shareRequest.reason,
          },
        }
      : {}),
    sharedWith: d.sharedWith,
    attachmentSizes: d.attachmentSizes,
  };
};

export const toGate = (r: SkillRequirement): SkillGate => ({
  kind: gateKinds[r.id],
  passed: r.met,
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.passedCases === undefined ? {} : { passedCases: r.passedCases }),
  ...(r.total === undefined ? {} : { total: r.total }),
  ...(r.threshold === undefined ? {} : { threshold: r.threshold }),
  ...(r.unpublishedTools ? { unpublishedTools: r.unpublishedTools } : {}),
});

const toVersions = (versions: SkillVersionResponse[]): SkillVersion[] => {
  const latest = Math.max(0, ...versions.map((v) => v.version));
  return [...versions]
    .sort((a, b) => b.version - a.version)
    .map((v) => ({
      version: v.version,
      publishedAt: v.publishedAt,
      by: v.by,
      ...(v.reason ? { reason: v.reason } : {}),
      current: v.version === latest,
      shared: false,
      ...(v.passed !== undefined && v.total !== undefined
        ? { score: { passed: v.passed, total: v.total } }
        : {}),
    }));
};

const toBase64 = async (file: Blob) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

const fromBase64 = (content: string) =>
  new Blob([Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0))], {
    type: 'application/zip',
  });

const conflict = (error: unknown) => (error as { status?: unknown } | null)?.status === 409;

export const skillsApi = ({ get, request, tenantPath }: ApiContext) => {
  const base = (tenant: string) => `${tenantPath(tenant)}/skills`;
  const one = (tenant: string, id: string) => `${base(tenant)}/${encodeURIComponent(id)}`;
  const query = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) search.set(key, String(value));
    const text = search.toString();
    return text ? `?${text}` : '';
  };
  const ownerQuery = (tenant: string, owner?: string) =>
    query({ owner: owner && owner !== tenant ? owner : undefined });

  const firstFree = async <T>(wanted: string, attempt: (id: string) => Promise<T>) => {
    for (let n = 1; ; n += 1) {
      try {
        return await attempt(n === 1 ? wanted : `${wanted}-${n}`);
      } catch (error) {
        if (!conflict(error) || n >= 20) throw error;
      }
    }
  };

  return {
    skillsPath: base,
    skillPath: one,
    list: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data: SkillSummaryResponse[] }>(base(tenant), signal)).data.map(toSummary),
    get: async (tenant: string, id: string, owner?: string, signal?: AbortSignal) =>
      toDetail(
        await get<SkillDetailResponse>(`${one(tenant, id)}${ownerQuery(tenant, owner)}`, signal),
      ),
    create: async (tenant: string, name = '') =>
      toDetail(
        await firstFree(skillSlug(name), (id) =>
          request<SkillDetailResponse>('POST', base(tenant), { id, name }),
        ),
      ),
    saveDraft: async (
      tenant: string,
      id: string,
      definition: SkillDefinition,
      revision: number,
    ) => {
      const saved = await request<SkillDetailResponse>(
        'PUT',
        one(tenant, id),
        { definition },
        { 'if-match': `"${revision}"` },
      );
      return { revision: saved.draft?.revision ?? revision };
    },
    versions: async (tenant: string, id: string, owner?: string, signal?: AbortSignal) =>
      toVersions(
        (
          await get<{ data: SkillVersionResponse[] }>(
            `${one(tenant, id)}/versions${ownerQuery(tenant, owner)}`,
            signal,
          )
        ).data,
      ),
    usage: async (
      tenant: string,
      id: string,
      owner?: string,
      signal?: AbortSignal,
    ): Promise<SkillUsage> => {
      const usage = await get<SkillUsageResponse>(
        `${one(tenant, id)}/usage${ownerQuery(tenant, owner)}`,
        signal,
      );
      return {
        services: usage.usedBy
          .filter((u) => u.tenant === tenant)
          .map((u) => ({ service: u.service, name: u.name, version: u.version })),
        sharedWith: new Set(usage.usedBy.map((u) => u.tenant).filter((t) => t !== tenant)).size,
      };
    },
    runTests: async (tenant: string, id: string) =>
      toTestRun(await request<SkillTestRunResponse>('POST', `${one(tenant, id)}/test-runs`, {})),
    publishCheck: async (
      tenant: string,
      id: string,
      signal?: AbortSignal,
    ): Promise<SkillPublishCheck> => {
      const checked = await get<SkillRequirementsResponse>(
        `${one(tenant, id)}/requirements`,
        signal,
      );
      const gates = checked.requirements.map(toGate);
      return { threshold: checked.threshold, blocked: gates.some((g) => !g.passed), gates };
    },
    publish: async (tenant: string, id: string, reason: string) => {
      const published = await request<SkillPublishResponse>(
        'POST',
        `${one(tenant, id)}/publish`,
        {},
        { 'change-reason': reason },
      );
      return { version: published.version ?? 0 };
    },
    requestShare: (tenant: string, id: string, reason: string) =>
      request<SkillShareResponse>(
        'POST',
        `${one(tenant, id)}/share`,
        { confirm: true },
        { 'change-reason': reason },
      ),
    withdrawShare: (tenant: string, id: string) =>
      request<SkillShareResponse>('DELETE', `${one(tenant, id)}/share`, undefined),
    copy: async (tenant: string, id: string, owner: string) =>
      toDetail(
        await firstFree(id, (target) =>
          request<SkillDetailResponse>('POST', `${one(tenant, id)}/copy`, {
            owner,
            ...(target === id ? {} : { id: target }),
          }),
        ),
      ),
    exportPackage: async (
      tenant: string,
      id: string,
      owner?: string,
      version?: number,
    ): Promise<SkillPackage> => {
      const pkg = await get<SkillPackageResponse>(
        `${one(tenant, id)}/export${query({ owner: owner && owner !== tenant ? owner : undefined, version })}`,
      );
      return { fileName: pkg.fileName, blob: fromBase64(pkg.contentBase64) };
    },
    importPackage: async (tenant: string, file: File) =>
      toDetail(
        await request<SkillDetailResponse>('POST', `${base(tenant)}/import`, {
          fileName: file.name,
          contentBase64: await toBase64(file),
        }),
      ),
    addAttachment: async (tenant: string, id: string, file: File) =>
      request<UploadedAttachment>('POST', `${one(tenant, id)}/attachments`, {
        name: file.name,
        contentBase64: await toBase64(file),
      }),
    tools: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data: SkillToolOption[] }>(`${tenantPath(tenant)}/skill-tools`, signal)).data,
    deleteCase: (tenant: string, id: string, index: number, revision: number) =>
      request<unknown>('DELETE', `${one(tenant, id)}/testcases/${index}`, undefined, {
        'if-match': `"${revision}"`,
        'change-reason': 'Slettet et testtilfelle',
      }),
    proposeFix: (tenant: string, id: string) =>
      request<SkillFix>('POST', `${one(tenant, id)}/fix`, {}),
    applyFix: (tenant: string, id: string, fixId: string) =>
      request<unknown>(
        'POST',
        `${one(tenant, id)}/fix/${encodeURIComponent(fixId)}/apply`,
        {},
        { 'change-reason': 'Brukte assistentens retting av instruksjonene' },
      ),
    assistantPath: (tenant: string, id: string) => `${one(tenant, id)}/assistant/turns`,
    assistantTurn: (tenant: string, id: string, body: SkillAssistantRequest) =>
      request<SkillAssistantTurn>('POST', `${one(tenant, id)}/assistant/turns`, body),
  };
};
