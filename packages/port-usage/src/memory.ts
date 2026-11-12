import {
  bucketMs,
  gatewayUsageSource,
  kindsWithOrg,
  organisationOf,
  parseSubject,
  queryProblems,
  subjectKinds,
  UsageGatewayError,
  type GatewayUsagePage,
  type GatewayUsageQuery,
  type GatewayUsageRow,
  type UsageGateway,
  type UsageQuery,
  type UsageRow,
  type UsageSource,
  type UsageSubject,
} from './usage.js';

export interface FakeKey {
  id: string;
  subject?: UsageSubject;
  consumer?: 'genki';
}

export interface FakeCall {
  key: string;
  model: string;
  provider?: string;
  at: Date | string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  /** Millionths of the gateway's currency; left out for a call the gateway could not price. */
  costMicros?: number;
  genkiTenant?: string;
}

interface RecordedCall {
  at: number;
  model: string;
  provider: string;
  chain: UsageSubject[];
  owner: UsageSubject | undefined;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  costMicros: number | undefined;
}

export interface MemoryUsageOptions {
  id?: string;
  now?: () => Date;
  currency?: string;
  /** The longest a call may run; a bucket is closed once its end plus this has passed. */
  maxCallMs?: number;
  pageSize?: number;
  scope?: string[];
}

const orgNumber = /^\d{9}$/;

const groupKey = (row: GatewayUsageRow) =>
  [
    row.model ?? '',
    row.provider ?? '',
    row.subject?.kind ?? '',
    row.subject?.id ?? '',
    row.subject?.org ?? '',
  ].join('\u0000');

const encodeCursor = (row: GatewayUsageRow) =>
  Buffer.from(JSON.stringify([row.start, groupKey(row)])).toString('base64url');

const decodeCursor = (cursor: string): [string, string] | undefined => {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'string')
      ? [value[0] as string, value[1] as string]
      : undefined;
  } catch {
    return undefined;
  }
};

/** A gateway in memory that keeps the contract's rules: the chain, genki attribution and closed buckets. */
export class MemoryUsageSource implements UsageSource, UsageGateway {
  readonly id: string;
  readonly #keys = new Map<string, FakeKey>();
  readonly #calls: RecordedCall[] = [];
  readonly #now: () => Date;
  readonly #currency: string;
  readonly #maxCallMs: number;
  readonly #pageSize: number;
  readonly #scope: Set<string> | undefined;
  readonly #source: UsageSource;
  readonly seen: GatewayUsageQuery[] = [];

  constructor(options: MemoryUsageOptions = {}) {
    this.id = options.id ?? 'gateway';
    this.#now = options.now ?? (() => new Date());
    this.#currency = options.currency ?? 'USD';
    this.#maxCallMs = options.maxCallMs ?? 10 * 60_000;
    this.#pageSize = options.pageSize ?? 500;
    this.#scope = options.scope ? new Set(options.scope) : undefined;
    this.#source = gatewayUsageSource(this.id, this);
  }

  addKey(key: FakeKey) {
    this.#keys.set(key.id, structuredClone(key));
  }

  /** Changes a key's subject; calls already recorded keep the chain they were made with. */
  moveKey(id: string, subject: UsageSubject | undefined) {
    const key = this.#keys.get(id);
    if (!key) throw new Error(`no key ${id}`);
    if (subject) key.subject = subject;
    else delete key.subject;
  }

  isClosed(start: number, bucket: 'hour' | 'day') {
    return start + bucketMs(bucket) + this.#maxCallMs <= this.#now().getTime();
  }

  record(call: FakeCall) {
    const key = this.#keys.get(call.key);
    if (!key) throw new UsageGatewayError(401, `no key ${call.key}`);
    const at = new Date(call.at).getTime();
    if (this.isClosed(Math.floor(at / bucketMs('hour')) * bucketMs('hour'), 'hour'))
      throw new Error('a closed bucket never changes; record calls in an open one');
    let chain: UsageSubject[];
    let owner: UsageSubject | undefined;
    if (key.consumer === 'genki') {
      if (!orgNumber.test(call.genkiTenant ?? ''))
        throw new UsageGatewayError(400, 'a genki call needs genki-tenant', [
          { path: 'genki-tenant', message: 'must be an organisation number of 9 digits' },
        ]);
      const tenant = call.genkiTenant as string;
      owner = { kind: 'genki', id: tenant, org: tenant };
      chain = [{ kind: 'apiKey', id: key.id }, owner, { kind: 'org', id: tenant }];
    } else {
      owner = key.subject;
      const org = organisationOf(key.subject);
      chain = [
        { kind: 'apiKey', id: key.id },
        ...(key.subject && key.subject.kind !== 'org' ? [key.subject] : []),
        ...(org ? [{ kind: 'org', id: org }] : []),
      ];
    }
    this.#calls.push({
      at,
      model: call.model,
      provider: call.provider ?? 'azure',
      chain: structuredClone(chain),
      owner: owner && structuredClone(owner),
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cachedInputTokens: call.cachedInputTokens ?? 0,
      cacheWriteTokens: call.cacheWriteTokens ?? 0,
      costMicros: call.costMicros,
    });
  }

  usage(query: UsageQuery): Promise<{ rows: UsageRow[]; next: string | null }> {
    return this.#source.usage(query);
  }

  async query(query: GatewayUsageQuery): Promise<GatewayUsagePage> {
    this.seen.push(structuredClone(query));
    const problems = queryProblems(query);
    if (problems.length > 0) throw new UsageGatewayError(400, 'invalid query', problems);
    const filter = query.subject === undefined ? undefined : parseSubject(query.subject);
    if (filter && kindsWithOrg.includes(filter.kind)) filter.org = query.org as string;
    if (filter && this.#scope) {
      const org = filter.kind === 'org' || filter.kind === 'genki' ? filter.id : filter.org;
      if (!org || !this.#scope.has(org))
        throw new UsageGatewayError(403, 'the subject is outside the client scope');
    }
    const step = bucketMs(query.bucket);
    const from = query.from.getTime();
    const to = query.to.getTime();
    const groups = query.groupBy ?? [];
    const byKind = groups.find((g) => subjectKinds.some((k) => k === g));
    const rows = new Map<string, GatewayUsageRow>();
    for (const call of this.#calls) {
      if (call.at < from || call.at >= to) continue;
      if (this.#scope && !call.chain.some((s) => s.kind === 'org' && this.#scope?.has(s.id)))
        continue;
      if (filter && !call.chain.some((s) => this.#matches(filter, s))) continue;
      const start = Math.floor(call.at / step) * step;
      const subject = groups.includes('subject')
        ? call.owner
        : byKind
          ? call.chain.find((s) => s.kind === byKind)
          : undefined;
      const row: GatewayUsageRow = {
        start: new Date(start).toISOString(),
        closed: this.isClosed(start, query.bucket),
        ...(groups.includes('model') ? { model: call.model } : {}),
        ...(groups.includes('provider') ? { provider: call.provider } : {}),
        ...(subject ? { subject: structuredClone(subject) } : {}),
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
        unpricedRequests: 0,
        cost: { currency: this.#currency, micros: 0 },
      };
      const key = `${row.start}\u0001${groupKey(row)}`;
      const sum = rows.get(key) ?? row;
      sum.inputTokens += call.inputTokens;
      sum.outputTokens += call.outputTokens;
      sum.cachedInputTokens += call.cachedInputTokens;
      sum.cacheWriteTokens += call.cacheWriteTokens;
      sum.requests += 1;
      if (call.costMicros === undefined) sum.unpricedRequests += 1;
      else sum.cost.micros += call.costMicros;
      rows.set(key, sum);
    }
    const ordered = [...rows.values()].sort(
      (a, b) => a.start.localeCompare(b.start) || groupKey(a).localeCompare(groupKey(b)),
    );
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (query.cursor !== undefined && !after)
      throw new UsageGatewayError(400, 'invalid cursor', [
        { path: 'cursor', message: 'is not a cursor this gateway gave' },
      ]);
    const rest = after
      ? ordered.filter(
          (r) => r.start > after[0] || (r.start === after[0] && groupKey(r) > after[1]),
        )
      : ordered;
    const data = rest.slice(0, this.#pageSize);
    const last = data.at(-1);
    return {
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      bucket: query.bucket,
      data,
      next: rest.length > data.length && last ? encodeCursor(last) : null,
    };
  }

  #matches(filter: UsageSubject, subject: UsageSubject) {
    if (filter.kind !== subject.kind || filter.id !== subject.id) return false;
    if (kindsWithOrg.includes(filter.kind)) return subject.org === filter.org;
    return true;
  }
}

export const memoryUsageSource = (options: MemoryUsageOptions = {}) =>
  new MemoryUsageSource(options);
