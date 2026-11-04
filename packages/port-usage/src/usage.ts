export interface Money {
  currency: string;
  micros: number;
}

export interface UsageSubject {
  kind: string;
  id: string;
  org?: string;
}

export interface UsageRow {
  source: string;
  start: string;
  closed: boolean;
  model?: string;
  subject?: UsageSubject;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  requests: number;
  unpricedRequests: number;
  cost: Money;
}

export type UsageBucket = 'hour' | 'day';

export interface UsageQuery {
  from: Date;
  to: Date;
  bucket: UsageBucket;
  cursor?: string;
}

export interface UsageSource {
  readonly id: string;
  usage(query: UsageQuery): Promise<{ rows: UsageRow[]; next: string | null }>;
}

/** The query of `GET /v1/usage` in docs/api/gateway.md. */
export interface GatewayUsageQuery extends UsageQuery {
  groupBy?: string[];
  subject?: string;
  org?: string;
}

export interface GatewayUsageRow {
  start: string;
  closed: boolean;
  model?: string;
  provider?: string;
  subject?: UsageSubject;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  requests: number;
  unpricedRequests: number;
  cost: Money;
}

export interface GatewayUsagePage {
  from: string;
  to: string;
  bucket: UsageBucket;
  data: GatewayUsageRow[];
  next: string | null;
}

/** The usage route of a gateway, as genki's contract describes it. */
export interface UsageGateway {
  query(query: GatewayUsageQuery): Promise<GatewayUsagePage>;
}

export interface ProblemError {
  path: string;
  message: string;
}

export class UsageGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: ProblemError[] = [],
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'UsageGatewayError';
  }
}

export const subjectKinds = ['org', 'team', 'service', 'user', 'apiKey', 'genki'] as const;

export const kindsWithOrg = ['team', 'service', 'user'];

const orgNumber = /^\d{9}$/;
const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const maxSpanMs: Record<UsageBucket, number> = { hour: 31 * dayMs, day: 400 * dayMs };

export const bucketMs = (bucket: UsageBucket) => (bucket === 'hour' ? hourMs : dayMs);

export const startOfHour = (at: Date) => new Date(Math.floor(at.getTime() / hourMs) * hourMs);

export const subjectText = (subject: UsageSubject) => `${subject.kind}:${subject.id}`;

export const parseSubject = (text: string): UsageSubject | undefined => {
  const at = text.indexOf(':');
  if (at <= 0) return undefined;
  return { kind: text.slice(0, at), id: text.slice(at + 1) };
};

/** The 400 problems of a usage query, by field, or none for a valid one. */
export const queryProblems = (query: GatewayUsageQuery): ProblemError[] => {
  const problems: ProblemError[] = [];
  const step = bucketMs(query.bucket);
  const from = query.from.getTime();
  const to = query.to.getTime();
  if (!['hour', 'day'].includes(query.bucket))
    problems.push({ path: 'bucket', message: 'must be hour or day' });
  if (Number.isNaN(from) || from % step !== 0)
    problems.push({ path: 'from', message: 'must be on a bucket boundary in UTC' });
  if (Number.isNaN(to) || to % step !== 0 || to <= from)
    problems.push({ path: 'to', message: 'must be a bucket boundary after from' });
  else if (to - from > (maxSpanMs[query.bucket] ?? 0))
    problems.push({ path: 'to', message: `is too far after from for ${query.bucket} buckets` });
  const groups = query.groupBy ?? [];
  const kinds = groups.filter((g) => g === 'subject' || subjectKinds.some((k) => k === g));
  if (groups.some((g) => !['model', 'provider', 'subject', ...subjectKinds].includes(g)))
    problems.push({ path: 'groupBy', message: 'takes model, provider, subject or a subject kind' });
  else if (kinds.length > 1)
    problems.push({ path: 'groupBy', message: 'takes subject or one subject kind, not both' });
  if (query.subject !== undefined) {
    const subject = parseSubject(query.subject);
    if (!subject || !subjectKinds.some((k) => k === subject.kind) || !subject.id)
      problems.push({ path: 'subject', message: 'must be <kind>:<id> with a known kind' });
    else if (kindsWithOrg.includes(subject.kind) && !orgNumber.test(query.org ?? ''))
      problems.push({ path: 'org', message: `is required with ${subject.kind} in subject` });
  }
  if (query.org !== undefined && !orgNumber.test(query.org))
    problems.push({ path: 'org', message: 'must be an organisation number of 9 digits' });
  return problems;
};

/** The organisation a row's owner belongs to, or none for a key or a row without an owner. */
export const organisationOf = (subject: UsageSubject | undefined): string | undefined => {
  if (!subject) return undefined;
  if (subject.kind === 'org' || subject.kind === 'genki')
    return orgNumber.test(subject.id) ? subject.id : undefined;
  if (kindsWithOrg.includes(subject.kind) && subject.org && orgNumber.test(subject.org))
    return subject.org;
  return undefined;
};

export const toUsageRow = (source: string, row: GatewayUsageRow): UsageRow => ({
  source,
  start: new Date(row.start).toISOString(),
  closed: row.closed,
  ...(row.model === undefined ? {} : { model: row.model }),
  ...(row.subject === undefined ? {} : { subject: row.subject }),
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cachedInputTokens: row.cachedInputTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  requests: row.requests,
  unpricedRequests: row.unpricedRequests,
  cost: row.cost,
});

/** A gateway as a usage source: hourly or daily rows grouped by model and owner. */
export const gatewayUsageSource = (id: string, gateway: UsageGateway): UsageSource => ({
  id,
  usage: async (query) => {
    const page = await gateway.query({ ...query, groupBy: ['model', 'subject'] });
    return { rows: page.data.map((row) => toUsageRow(id, row)), next: page.next };
  },
});
