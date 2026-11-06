import type { Principal } from '@genai/contracts';
import type { Kernel } from '@genai/kernel';
import { splitFor } from './drafting.js';
import { EvalError } from './evaluators.js';
import {
  feedback as feedbackSchema,
  parseTestSet,
  type CaseType,
  type Feedback,
  type SourceRef,
  type TestSet,
} from './schema.js';
import type { TestSetStore } from './store.js';

export interface PiiFinding {
  category: string;
  count: number;
}

export interface PiiRedactor {
  redact(text: string): { text: string; findings: PiiFinding[] };
}

const weights1 = [3, 7, 6, 1, 8, 9, 4, 5, 2];
const weights2 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

const control = (digits: number[], weights: number[]) => {
  const rest = 11 - (weights.reduce((sum, w, i) => sum + w * (digits[i] as number), 0) % 11);
  return rest === 11 ? 0 : rest;
};

export const isNationalId = (value: string) => {
  const digits = value.replace(/\s/g, '');
  if (!/^\d{11}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const day = Number(digits.slice(0, 2)) % 40;
  const month = Number(digits.slice(2, 4)) % 40;
  if (day < 1 || day > 31 || month < 1 || month > 12) return false;
  return control(d, weights1) === d[9] && control(d, weights2) === d[10];
};

const patterns: { category: string; pattern: RegExp; accept?: (match: string) => boolean }[] = [
  { category: 'national-id', pattern: /\b\d{6}\s?\d{5}\b/g, accept: isNationalId },
  { category: 'email', pattern: /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g },
  {
    category: 'phone',
    pattern:
      /(?<![\d/-])(?:\+47[\s-]?)?[2-9](?:\d{2}[\s-]?\d{2}[\s-]?\d{3}|\d(?:[\s-]?\d{2}){3})(?![\d/-])/g,
  },
];

export const basicPiiRedactor: PiiRedactor = {
  redact: (text) => {
    let out = text;
    const findings: PiiFinding[] = [];
    for (const { category, pattern, accept } of patterns) {
      let count = 0;
      out = out.replace(pattern, (match) => {
        if (accept && !accept(match)) return match;
        count += 1;
        return `[${category}]`;
      });
      if (count > 0) findings.push({ category, count });
    }
    return { text: out, findings };
  },
};

export interface FeedbackInput {
  task: string;
  rating: Feedback['rating'];
  comment?: string;
  reasons?: string[];
}

export interface FeedbackRecord extends Feedback {
  tenant: string;
  capability?: string;
}

export interface FeedbackView {
  rating: Feedback['rating'];
  at: string;
  task?: string;
  comment?: string;
  reasons?: string[];
}

export const minFeedbackGroup = 5;

export const anonymousFeedback = (
  records: FeedbackRecord[],
  minGroup = minFeedbackGroup,
): FeedbackView[] => {
  const sizes = new Map<string, number>();
  for (const r of records) sizes.set(r.rating, (sizes.get(r.rating) ?? 0) + 1);
  return records.map((r) =>
    (sizes.get(r.rating) ?? 0) >= minGroup
      ? {
          task: r.task,
          rating: r.rating,
          at: r.at,
          ...(r.comment ? { comment: r.comment } : {}),
          ...(r.reasons?.length ? { reasons: r.reasons } : {}),
        }
      : { rating: r.rating, at: r.at.slice(0, 10) },
  );
};

/**
 * The current feedback: the latest record per task and credential, newest first. A later rating or
 * comment on the same answer from the same credential replaces the earlier one instead of counting
 * twice; every record stays in the store and on the task timeline. `records` must be newest first.
 */
export const currentFeedback = (records: FeedbackRecord[]): FeedbackRecord[] => {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = JSON.stringify([r.task, r.by.kind, r.by.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export interface FeedbackStore {
  save(record: FeedbackRecord): Promise<void>;
  list(
    tenant: string,
    filter?: { task?: string; rating?: Feedback['rating'] },
  ): Promise<FeedbackRecord[]>;
}

export class InMemoryFeedbackStore implements FeedbackStore {
  readonly #records: FeedbackRecord[] = [];

  async save(record: FeedbackRecord) {
    this.#records.push(structuredClone(record));
  }

  async list(tenant: string, filter: { task?: string; rating?: Feedback['rating'] } = {}) {
    const newest = [...this.#records]
      .reverse()
      .filter((r) => r.tenant === tenant && (filter.task === undefined || r.task === filter.task))
      .sort((a, b) => b.at.localeCompare(a.at));
    return currentFeedback(newest)
      .filter((r) => filter.rating === undefined || r.rating === filter.rating)
      .map((r) => structuredClone(r));
  }
}

export const recordFeedback = async (
  deps: { kernel: Kernel; store: FeedbackStore; now?: () => Date; redactor?: PiiRedactor },
  principal: Principal,
  input: FeedbackInput,
): Promise<FeedbackRecord> => {
  const task = await deps.kernel.task(principal, input.task);
  const redactor = deps.redactor ?? basicPiiRedactor;
  const comment = input.comment ? redactor.redact(input.comment).text : undefined;
  const reasons = (input.reasons ?? []).map((r) => redactor.redact(r).text);
  const entry = feedbackSchema.parse({
    task: input.task,
    rating: input.rating,
    ...(comment ? { comment } : {}),
    ...(reasons.length > 0 ? { reasons } : {}),
    by: { kind: principal.kind, id: `${principal.issuer}:${principal.subject}` },
    at: (deps.now?.() ?? new Date()).toISOString(),
  });
  await deps.kernel.annotate(principal, input.task, { type: 'kernel.feedback', data: entry });
  const record = { ...entry, tenant: task.tenant, capability: task.service.capability.id };
  await deps.store.save(record);
  return record;
};

export const candidateStatuses = ['pending-review', 'accepted', 'rejected', 'expired'] as const;
export type CandidateStatus = (typeof candidateStatuses)[number];

export const candidateOrigins = ['feedback', 'playground', 'assistant'] as const;
export type CandidateOrigin = (typeof candidateOrigins)[number];

export interface TestCaseCandidate {
  id: string;
  tenant: string;
  task?: string;
  question: string;
  answer?: string;
  sources: SourceRef[];
  findings: PiiFinding[];
  status: CandidateStatus;
  proposedBy: string;
  proposedAt: string;
  expiresAt: string;
  service?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reason?: string;
  testSet?: { id: string; version: number; case: string };
  targetTestSet?: string;
  origin?: CandidateOrigin;
}

export interface CandidateStore {
  save(candidate: TestCaseCandidate): Promise<void>;
  get(id: string): Promise<TestCaseCandidate | undefined>;
  list(tenant: string, status?: CandidateStatus): Promise<TestCaseCandidate[]>;
}

export class InMemoryCandidateStore implements CandidateStore {
  readonly #candidates = new Map<string, TestCaseCandidate>();

  async save(candidate: TestCaseCandidate) {
    this.#candidates.set(candidate.id, structuredClone(candidate));
  }

  async get(id: string) {
    const found = this.#candidates.get(id);
    return found && structuredClone(found);
  }

  async list(tenant: string, status?: CandidateStatus) {
    return [...this.#candidates.values()]
      .filter((c) => c.tenant === tenant && (status === undefined || c.status === status))
      .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))
      .map((c) => structuredClone(c));
  }
}

const day = 24 * 60 * 60 * 1000;

export interface ProposeInput {
  tenant: string;
  task?: string;
  question: string;
  answer?: string;
  sources?: SourceRef[];
  service?: string;
  proposedBy: string;
  ttlDays?: number;
}

export const proposeTestCase = async (
  deps: { store: CandidateStore; redactor: PiiRedactor; now?: () => Date; newId?: () => string },
  input: ProposeInput,
): Promise<TestCaseCandidate> => {
  const now = deps.now?.() ?? new Date();
  const question = deps.redactor.redact(input.question);
  const answer = input.answer === undefined ? undefined : deps.redactor.redact(input.answer);
  const leftover = [question.text, answer?.text ?? '']
    .map((t) => deps.redactor.redact(t).findings)
    .flat();
  if (leftover.length > 0)
    throw new EvalError('the text still contains personal data after anonymisation');
  const merged = new Map<string, number>();
  for (const f of [...question.findings, ...(answer?.findings ?? [])])
    merged.set(f.category, (merged.get(f.category) ?? 0) + f.count);
  const candidate: TestCaseCandidate = {
    id: deps.newId?.() ?? `fb-${crypto.randomUUID().slice(0, 8)}`,
    tenant: input.tenant,
    ...(input.task ? { task: input.task } : {}),
    question: question.text,
    ...(answer ? { answer: answer.text } : {}),
    sources: input.sources ?? [],
    findings: [...merged].map(([category, count]) => ({ category, count })),
    status: 'pending-review',
    proposedBy: input.proposedBy,
    proposedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlDays ?? 180) * day).toISOString(),
    ...(input.service ? { service: input.service } : {}),
  };
  await deps.store.save(candidate);
  return candidate;
};

export interface ReviewInput {
  candidate: string;
  reviewer: string;
  decision: 'accept' | 'reject';
  reason?: string;
  testSet?: string;
  referenceAnswer?: string;
  type?: CaseType;
}

export const reviewCandidate = async (
  deps: { store: CandidateStore; testSets: TestSetStore; now?: () => Date },
  input: ReviewInput,
): Promise<TestCaseCandidate> => {
  const now = deps.now?.() ?? new Date();
  const candidate = await deps.store.get(input.candidate);
  if (!candidate) throw new EvalError(`no candidate ${input.candidate}`);
  if (candidate.status !== 'pending-review')
    throw new EvalError(`candidate ${candidate.id} is already ${candidate.status}`);
  if (candidate.expiresAt <= now.toISOString()) {
    const expired = { ...candidate, status: 'expired' as const };
    await deps.store.save(expired);
    throw new EvalError(`candidate ${candidate.id} has expired`);
  }
  const reviewed = {
    reviewedBy: input.reviewer,
    reviewedAt: now.toISOString(),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  if (input.decision === 'reject') {
    const rejected = { ...candidate, ...reviewed, status: 'rejected' as const };
    await deps.store.save(rejected);
    return rejected;
  }
  if (!input.testSet) throw new EvalError('accepting a candidate needs a target test set');
  const current = await deps.testSets.get(candidate.tenant, input.testSet);
  if (!current) throw new EvalError(`no test set ${input.testSet} for ${candidate.tenant}`);
  const next = withCase(current, candidate, input.referenceAnswer ?? candidate.answer, input.type);
  await deps.testSets.put(next);
  const accepted: TestCaseCandidate = {
    ...candidate,
    ...reviewed,
    status: 'accepted',
    testSet: { id: next.metadata.id, version: next.metadata.version, case: candidate.id },
  };
  await deps.store.save(accepted);
  return accepted;
};

const withCase = (
  set: TestSet,
  candidate: TestCaseCandidate,
  referenceAnswer?: string,
  type?: CaseType,
): TestSet =>
  parseTestSet({
    ...set,
    metadata: { ...set.metadata, version: set.metadata.version + 1 },
    spec: {
      ...set.spec,
      cases: [
        ...set.spec.cases,
        {
          id: candidate.id,
          split: splitFor(candidate.id),
          input: candidate.question,
          expected: {
            sources: candidate.sources,
            ...(referenceAnswer ? { referenceAnswer } : {}),
          },
          grounding:
            type === 'must_reject'
              ? 'refusal-expected'
              : candidate.sources.length > 0
                ? 'sources-and-answer'
                : 'answer-only',
          ...(type ? { type } : {}),
          tags: ['from-feedback'],
          origin: {
            ...(candidate.task ? { task: candidate.task } : {}),
            expiresAt: candidate.expiresAt,
          },
        },
      ],
    },
  });

export const withoutExpiredCases = (set: TestSet, now: Date): TestSet | undefined => {
  const at = now.toISOString();
  const kept = set.spec.cases.filter((c) => !(c.origin?.expiresAt && c.origin.expiresAt <= at));
  if (kept.length === set.spec.cases.length) return undefined;
  if (kept.length === 0) throw new EvalError(`every case in ${set.metadata.id} has expired`);
  return parseTestSet({
    ...set,
    metadata: { ...set.metadata, version: set.metadata.version + 1 },
    spec: { ...set.spec, cases: kept },
  });
};

export const expireCandidates = async (store: CandidateStore, tenant: string, now: Date) => {
  const at = now.toISOString();
  const expired: string[] = [];
  for (const c of await store.list(tenant, 'pending-review')) {
    if (c.expiresAt <= at) {
      await store.save({ ...c, status: 'expired' });
      expired.push(c.id);
    }
  }
  return expired;
};
