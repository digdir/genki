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

export const gatewayGroupFields = ['provider', 'requestModel', 'responseModel'] as const;
export type GatewayGroupField = (typeof gatewayGroupFields)[number];

export const usageAttributes = ['usage.org', 'usage.client'] as const;
export type UsageAttribute = (typeof usageAttributes)[number];

export type GatewayGroupBy =
  { field: GatewayGroupField } | { field: 'attributes'; key: UsageAttribute };

export interface GatewayUsageRequest {
  timeRange: { from: string; to: string };
  bucketSeconds: number;
  groupBy?: GatewayGroupBy[];
  filters?: {
    httpStatus?: number[];
    attributes?: Partial<Record<UsageAttribute, string>>;
  };
}

export type GatewayGroupKey = GatewayGroupField | UsageAttribute;

export type GatewayGroup = Partial<Record<GatewayGroupKey, string | null>>;

export interface GatewayUsageFigures {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

export interface GatewayUsageGroup extends GatewayUsageFigures {
  group: GatewayGroup;
}

export interface GatewayUsageBucket extends GatewayUsageGroup {
  start: string;
}

export interface GatewayUsageAnswer {
  timeRange: { from: string; to: string };
  bucketSeconds: number;
  buckets: GatewayUsageBucket[];
  groups: GatewayUsageGroup[];
}

export interface UsageGateway {
  query(request: GatewayUsageRequest): Promise<GatewayUsageAnswer>;
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

const orgNumber = /^\d{9}$/;
const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

export const minBucketSeconds = 3600;
export const maxRangeMs = 31 * dayMs;

export const bucketMs = (bucket: UsageBucket) => (bucket === 'hour' ? hourMs : dayMs);

export const startOfHour = (at: Date) => new Date(Math.floor(at.getTime() / hourMs) * hourMs);

export const endOfHour = (at: Date) => new Date(Math.ceil(at.getTime() / hourMs) * hourMs);

export const rfc3339 = (at: Date) => at.toISOString().replace('.000Z', 'Z');

export const requestProblems = (request: GatewayUsageRequest): ProblemError[] => {
  const problems: ProblemError[] = [];
  const from = Date.parse(request.timeRange?.from ?? '');
  const to = Date.parse(request.timeRange?.to ?? '');
  if (!Number.isInteger(request.bucketSeconds) || request.bucketSeconds < minBucketSeconds)
    problems.push({ path: 'bucketSeconds', message: `must be at least ${minBucketSeconds}` });
  if (Number.isNaN(from)) problems.push({ path: 'timeRange.from', message: 'must be a time' });
  if (Number.isNaN(to)) problems.push({ path: 'timeRange.to', message: 'must be a time' });
  else if (!Number.isNaN(from) && (to - from < hourMs || to - from > maxRangeMs))
    problems.push({ path: 'timeRange', message: 'must be between 1 hour and 31 days' });
  for (const [i, group] of (request.groupBy ?? []).entries()) {
    const known =
      group.field === 'attributes'
        ? usageAttributes.includes(group.key)
        : gatewayGroupFields.includes(group.field);
    if (!known) problems.push({ path: `groupBy.${i}`, message: 'is not a field it groups by' });
  }
  for (const key of Object.keys(request.filters?.attributes ?? {}))
    if (!usageAttributes.some((a) => a === key))
      problems.push({ path: `filters.attributes.${key}`, message: 'is not an attribute' });
  return problems;
};

export const organisationOf = (subject: UsageSubject | undefined): string | undefined => {
  if (!subject) return undefined;
  if (subject.kind === 'org' || subject.kind === 'genki')
    return orgNumber.test(subject.id) ? subject.id : undefined;
  if (subject.org && orgNumber.test(subject.org)) return subject.org;
  return undefined;
};

export interface GatewaySourceOptions {
  genkiClients?: readonly string[];
  now?: () => Date;
  settleMs?: number;
}

export const usageGroupBy: GatewayGroupBy[] = [
  { field: 'requestModel' },
  { field: 'attributes', key: 'usage.org' },
  { field: 'attributes', key: 'usage.client' },
];

const subjectOf = (
  group: GatewayGroup,
  genkiClients: ReadonlySet<string>,
): UsageSubject | undefined => {
  const org = group['usage.org'];
  if (!org || !orgNumber.test(org)) return undefined;
  const client = group['usage.client'];
  return client && genkiClients.has(client)
    ? { kind: 'genki', id: org, org }
    : { kind: 'org', id: org };
};

const rowKey = (row: UsageRow) =>
  [row.start, row.model ?? '', row.subject?.kind ?? '', row.subject?.id ?? ''].join('\u0000');

export const rangePieces = (from: Date, to: Date, bucket: UsageBucket) => {
  const step = bucketMs(bucket);
  const longest = Math.floor(maxRangeMs / step) * step;
  const pieces: { from: Date; to: Date }[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += longest)
    pieces.push({ from: new Date(at), to: new Date(Math.min(at + longest, to.getTime())) });
  return pieces;
};

export const gatewayUsageSource = (
  id: string,
  gateway: UsageGateway,
  options: GatewaySourceOptions = {},
): UsageSource => {
  const genkiClients = new Set(options.genkiClients ?? []);
  const now = options.now ?? (() => new Date());
  const settleMs = options.settleMs ?? 20 * 60_000;
  return {
    id,
    usage: async (query) => {
      const step = bucketMs(query.bucket);
      const rows = new Map<string, UsageRow>();
      const from = startOfHour(query.from);
      const to = endOfHour(query.to);
      for (const piece of rangePieces(from, to, query.bucket)) {
        const answer = await gateway.query({
          timeRange: { from: rfc3339(piece.from), to: rfc3339(piece.to) },
          bucketSeconds: step / 1000,
          groupBy: usageGroupBy,
          filters: { httpStatus: [200] },
        });
        for (const bucket of answer.buckets) {
          const startMs = Date.parse(bucket.start);
          const subject = subjectOf(bucket.group, genkiClients);
          const model = bucket.group.requestModel;
          const row: UsageRow = {
            source: id,
            start: new Date(startMs).toISOString(),
            closed: startMs + step + settleMs <= now().getTime(),
            ...(model ? { model } : {}),
            ...(subject ? { subject } : {}),
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            requests: 0,
            unpricedRequests: 0,
            cost: { currency: 'USD', micros: 0 },
          };
          const sum = rows.get(rowKey(row)) ?? row;
          sum.inputTokens += bucket.inputTokens;
          sum.outputTokens += bucket.outputTokens;
          sum.cachedInputTokens += bucket.cacheReadTokens;
          sum.cacheWriteTokens += bucket.cacheWriteTokens;
          sum.requests += bucket.requests;
          sum.cost.micros += Math.round(bucket.cost * 1_000_000);
          rows.set(rowKey(row), sum);
        }
      }
      return {
        rows: [...rows.values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b))),
        next: null,
      };
    },
  };
};
