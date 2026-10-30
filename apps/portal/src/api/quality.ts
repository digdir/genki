import type { ApiContext } from '../api';
import { translator, type T } from '../i18n';
import { ApiError } from './error';

export type CaseType = 'criteria' | 'exact' | 'must_reject';
export type CaseSplit = 'locked' | 'open';
export type RunVersion = 'draft' | 'published' | number;

export interface ServiceTestSet {
  id: string;
  name: string;
  cases: number;
  split?: { locked: number; open: number };
}

export interface ServiceCase {
  id: string;
  input: string;
  expected: string;
  type: CaseType;
  split: CaseSplit;
}

/** A reference answer and named criteria, as a judge reads them. */
export interface CaseExpectation {
  referenceAnswer?: string;
  criteria?: Record<string, string>;
}

export type NewServiceCase = Omit<ServiceCase, 'id' | 'expected'> & {
  expected: string | CaseExpectation;
};

export interface MetricSummary {
  mean: number;
  ci: [number, number];
  n: number;
}

export interface EvalRun {
  id: string;
  status: 'running' | 'waiting-for-scores' | 'completed' | 'failed' | 'interrupted' | (string & {});
  testSet: string;
  version: RunVersion;
  startedAt: string;
  endedAt?: string | null;
  score?: number | null;
  passed?: number | null;
  total?: number | null;
  cost?: number | null;
  metrics?: Record<string, MetricSummary>;
  incomplete?: { evaluator: string; reason: string }[];
  judges?: string[];
}

export interface EvalCaseResult {
  caseId: string;
  input: string;
  expected: string;
  output: string;
  pass: boolean;
  reason?: string;
}

export interface EvalRunDetail extends EvalRun {
  cases: EvalCaseResult[];
}

export type CandidateOrigin = 'feedback' | 'playground' | 'assistant' | (string & {});

export interface Candidate {
  id: string;
  input: string;
  expected?: string;
  origin: CandidateOrigin;
  status: string;
  createdAt: string;
}

export interface NewCandidate {
  service: string;
  input: string;
  expected?: string;
  origin: CandidateOrigin;
  task?: string;
  testSet?: string;
}

export interface CandidateReview {
  decision: 'accept' | 'reject';
  testSet?: string;
  expected?: string;
  type?: CaseType;
}

export type ImprovementStatus = 'running' | 'ready' | 'failed' | 'approved' | 'rejected';

export interface Improvement {
  id: string;
  status: ImprovementStatus;
  language?: string;
  change?: { path: string; before: string; after: string };
  scores?: {
    testSet: string;
    before: number;
    after: number;
    passedBefore: number;
    passedAfter: number;
    total: number;
  };
  examples?: { input: string; before: string; after: string }[];
  reasons?: string[] | string;
  createdAt: string;
}

export interface ServiceDraft {
  revision: number;
  definition: Record<string, unknown>;
  files: Record<string, string>;
  at: string;
  reason: string;
  baseVersion?: number;
  latestVersion?: number;
}

export interface DraftConflict {
  path: string;
  published: unknown;
  draft: unknown;
}

export interface OpenedDraft extends ServiceDraft {
  behind: boolean;
  conflicts: DraftConflict[];
  rebasedFrom?: number;
}

export interface DraftRebase {
  draft: ServiceDraft;
  conflicts: DraftConflict[];
  applied: boolean;
}

const isFinished = (r: EvalRun) => r.status === 'completed' && typeof r.total === 'number';

export const latestRunFact = (runs: EvalRun[], t: T = translator('nb')) => {
  const done = runs.filter(isFinished).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const last = done[0];
  if (!last || !last.total) return t('services.scoreNotRun');
  const passed = last.passed ?? 0;
  return t('services.scorePassed', {
    passed,
    total: last.total,
    percent: Math.round((passed / last.total) * 100),
  });
};

export const qualityApi = ({ get, request, tenantPath }: ApiContext) => {
  const service = (tenant: string, id: string) =>
    `${tenantPath(tenant)}/services/${encodeURIComponent(id)}`;
  const set = (tenant: string, id: string) =>
    `${tenantPath(tenant)}/test-sets/${encodeURIComponent(id)}`;
  const why = (reason: string) => ({ 'change-reason': reason });

  const api = {
    draft: async (tenant: string, id: string, signal?: AbortSignal) => {
      try {
        const draft = await get<Partial<ServiceDraft> | undefined>(
          `${service(tenant, id)}/draft`,
          signal,
        );
        return draft?.definition && typeof draft.revision === 'number'
          ? ({ files: {}, ...draft } as ServiceDraft)
          : undefined;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
    },
    openDraft: async (
      tenant: string,
      id: string,
      reason: string,
      retry = true,
    ): Promise<OpenedDraft | undefined> => {
      try {
        const draft = await request<
          | (Partial<OpenedDraft> & { baseVersion?: number | null; latestVersion?: number | null })
          | null
        >('GET', `${service(tenant, id)}/draft?rebase=clean`, undefined, why(reason));
        if (!draft?.definition || typeof draft.revision !== 'number') return undefined;
        const { baseVersion, latestVersion, ...rest } = draft;
        return {
          files: {},
          ...rest,
          ...(typeof baseVersion === 'number' ? { baseVersion } : {}),
          ...(typeof latestVersion === 'number' ? { latestVersion } : {}),
          behind: draft.behind === true,
          conflicts: draft.conflicts ?? [],
        } as OpenedDraft;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        if (retry && error instanceof ApiError && error.status === 409)
          return api.openDraft(tenant, id, reason, false);
        throw error;
      }
    },
    saveDraft: (
      tenant: string,
      id: string,
      body: {
        definition: Record<string, unknown>;
        files: Record<string, string>;
        revision: number;
      },
      reason: string,
    ) => request<ServiceDraft>('PUT', `${service(tenant, id)}/draft`, body, why(reason)),
    rebaseDraft: async (tenant: string, id: string, reason: string, onlyIfClean = false) => {
      const result = await request<{
        draft: Omit<ServiceDraft, 'files'> & { files?: Record<string, string> };
        conflicts?: DraftConflict[];
        applied?: boolean;
      }>(
        'POST',
        `${service(tenant, id)}/draft/rebase`,
        onlyIfClean ? { onlyIfClean } : {},
        why(reason),
      );
      return {
        draft: { ...result.draft, files: result.draft.files ?? {} },
        conflicts: result.conflicts ?? [],
        applied: result.applied ?? true,
      } satisfies DraftRebase;
    },
    deleteDraft: (tenant: string, id: string, revision: number, reason: string) =>
      request<{ revision: number }>(
        'DELETE',
        `${service(tenant, id)}/draft`,
        { revision },
        why(reason),
      ),
    testSets: async (tenant: string, id: string, signal?: AbortSignal) =>
      (await get<{ data: ServiceTestSet[] }>(`${service(tenant, id)}/test-sets`, signal)).data,
    createTestSet: (
      tenant: string,
      body: { id?: string; name: string; service: string },
      reason: string,
    ) => request<ServiceTestSet>('POST', `${tenantPath(tenant)}/test-sets`, body, why(reason)),
    cases: async (tenant: string, setId: string, signal?: AbortSignal) =>
      (await get<{ data: ServiceCase[] }>(`${set(tenant, setId)}/cases`, signal)).data,
    addCase: (tenant: string, setId: string, body: NewServiceCase, reason: string) =>
      request<ServiceCase>('POST', `${set(tenant, setId)}/cases`, body, why(reason)),
    deleteCase: (tenant: string, setId: string, caseId: string, reason: string) =>
      request<unknown>(
        'DELETE',
        `${set(tenant, setId)}/cases/${encodeURIComponent(caseId)}`,
        {},
        why(reason),
      ),
    startRun: (
      tenant: string,
      id: string,
      body: { testSet: string; version?: RunVersion },
      reason: string,
    ) => request<{ id: string }>('POST', `${service(tenant, id)}/eval-runs`, body, why(reason)),
    runs: async (tenant: string, id: string, signal?: AbortSignal) =>
      (await get<{ data: EvalRun[] }>(`${service(tenant, id)}/eval-runs`, signal)).data,
    run: (tenant: string, runId: string, signal?: AbortSignal) =>
      get<EvalRunDetail>(`${tenantPath(tenant)}/eval-runs/${encodeURIComponent(runId)}`, signal),
    candidates: async (tenant: string, id: string, signal?: AbortSignal) =>
      (
        await get<{ data: Candidate[] }>(
          `${tenantPath(tenant)}/testcase-candidates?service=${encodeURIComponent(id)}`,
          signal,
        )
      ).data,
    proposeCandidate: (tenant: string, body: NewCandidate, reason: string) =>
      request<Candidate>(
        'POST',
        `${tenantPath(tenant)}/testcase-candidates`,
        { ...body, question: body.input },
        why(reason),
      ),
    reviewCandidate: (tenant: string, candidateId: string, body: CandidateReview, reason: string) =>
      request<unknown>(
        'POST',
        `${tenantPath(tenant)}/testcase-candidates/${encodeURIComponent(candidateId)}/review`,
        body,
        why(reason),
      ),
    startImprovement: (tenant: string, id: string, reason: string, language?: string) =>
      request<{ id: string }>(
        'POST',
        `${service(tenant, id)}/improvements`,
        language ? { language } : {},
        why(reason),
      ),
    improvements: async (tenant: string, id: string, signal?: AbortSignal) =>
      (await get<{ data: Improvement[] }>(`${service(tenant, id)}/improvements`, signal)).data,
    decideImprovement: (
      tenant: string,
      id: string,
      improvementId: string,
      approve: boolean,
      reason: string,
    ) =>
      request<Improvement>(
        'POST',
        `${service(tenant, id)}/improvements/${encodeURIComponent(improvementId)}/decision`,
        { approve },
        why(reason),
      ),
  };
  return api;
};
