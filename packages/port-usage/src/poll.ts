import type { CurrencyRate } from './money.js';
import { organisationOf, startOfHour, type UsageRow, type UsageSource } from './usage.js';

export interface UsageBucketWrite {
  start: string;
  closed: boolean;
  rows: UsageRow[];
}

/** Where the poll keeps a source's hourly rows and its `closedThrough` mark. */
export interface UsageBucketStore {
  closedThrough(source: string): Promise<string | undefined>;
  /** Hours that hold stored rows of the source that were open when stored. */
  openStarts(source: string): Promise<string[]>;
  /** Writes one bucket and moves the mark, in one transaction; counts closed rows that came back different. */
  store(
    source: string,
    bucket: UsageBucketWrite,
    closedThrough: string | undefined,
  ): Promise<{ breaches: number }>;
  advance(source: string, closedThrough: string): Promise<void>;
}

export interface AssignedUsageRow extends UsageRow {
  tenant: string;
}

export interface UsageReads {
  tenantRows(tenants: readonly string[], from: Date, to: Date): Promise<AssignedUsageRow[]>;
  /** Rows whose owner is no tenant; only operators read them. */
  unassignedRows(from: Date, to: Date): Promise<UsageRow[]>;
  rates(): Promise<CurrencyRate[]>;
}

export interface PollOptions {
  firstStart: Date;
  now?: () => Date;
  /** An hour without rows counts as closed this long after its end. */
  settleMs?: number;
  pieceDays?: number;
  onBreach?(source: string, start: string, rows: number): void;
}

export interface PollResult {
  buckets: number;
  breaches: number;
  closedThrough: string | undefined;
}

const hourMs = 3_600_000;

const readAll = async (source: UsageSource, from: Date, to: Date) => {
  const rows: UsageRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await source.usage({
      from,
      to,
      bucket: 'hour',
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...page.rows);
    cursor = page.next ?? undefined;
  } while (cursor !== undefined);
  return rows;
};

/** Reads a source's hours from its mark to the end of the current hour and stores them. */
export const pollUsage = async (
  source: UsageSource,
  store: UsageBucketStore,
  options: PollOptions,
): Promise<PollResult> => {
  const now = (options.now ?? (() => new Date()))();
  const settleMs = options.settleMs ?? 20 * 60_000;
  const pieceMs = (options.pieceDays ?? 31) * 24 * hourMs;
  const end = startOfHour(now).getTime() + hourMs;
  const saved = await store.closedThrough(source.id);
  let mark = saved;
  let written = mark;
  let unbroken = true;
  let buckets = 0;
  let breaches = 0;
  const open = new Set(await store.openStarts(source.id));
  for (
    let from = saved ? Date.parse(saved) : startOfHour(options.firstStart).getTime();
    from < end;
    from += pieceMs
  ) {
    const to = Math.min(from + pieceMs, end);
    const rows = await readAll(source, new Date(from), new Date(to));
    const byStart = new Map<string, UsageRow[]>();
    for (const row of rows) byStart.set(row.start, [...(byStart.get(row.start) ?? []), row]);
    const lastClosed = rows
      .filter((r) => r.closed)
      .reduce((a, r) => (r.start > a ? r.start : a), '');
    for (let at = from; at < to; at += hourMs) {
      const start = new Date(at).toISOString();
      const found = byStart.get(start) ?? [];
      const closed =
        found.length > 0
          ? found.every((r) => r.closed)
          : start < lastClosed || at + hourMs + settleMs <= now.getTime();
      if (closed && unbroken) mark = new Date(at + hourMs).toISOString();
      else unbroken = false;
      if (found.length === 0 && !open.has(start)) continue;
      const result = await store.store(source.id, { start, closed, rows: found }, mark);
      written = mark;
      buckets += 1;
      if (result.breaches > 0) {
        breaches += result.breaches;
        options.onBreach?.(source.id, start, result.breaches);
      }
    }
    if (mark !== written && mark !== undefined) {
      await store.advance(source.id, mark);
      written = mark;
    }
  }
  return { buckets, breaches, closedThrough: mark };
};

const rowKey = (row: UsageRow) =>
  [
    row.source,
    row.start,
    row.model ?? '',
    row.subject?.kind ?? '',
    row.subject?.id ?? '',
    row.subject?.org ?? '',
  ].join('\u0000');

const figures = (row: UsageRow) =>
  JSON.stringify([
    row.inputTokens,
    row.outputTokens,
    row.cachedInputTokens,
    row.cacheWriteTokens,
    row.requests,
    row.unpricedRequests,
    row.cost.currency,
    row.cost.micros,
  ]);

/** The bucket store in memory: rows of a tenant's organisation are assigned to it, the rest are not. */
export class InMemoryUsageBuckets implements UsageBucketStore, UsageReads {
  readonly #rows = new Map<string, AssignedUsageRow | UsageRow>();
  readonly #marks = new Map<string, string>();
  #rates: CurrencyRate[] = [];

  constructor(private readonly tenants: () => Iterable<string> | Promise<Iterable<string>>) {}

  async closedThrough(source: string) {
    return this.#marks.get(source);
  }

  async openStarts(source: string) {
    return [
      ...new Set(
        [...this.#rows.values()]
          .filter((r) => r.source === source && !r.closed)
          .map((r) => r.start),
      ),
    ];
  }

  async store(source: string, bucket: UsageBucketWrite, closedThrough: string | undefined) {
    const tenants = new Set(await this.tenants());
    for (const [key, row] of this.#rows)
      if (row.source === source && row.start === bucket.start && !row.closed)
        this.#rows.delete(key);
    let breaches = 0;
    for (const incoming of bucket.rows) {
      const row = { ...structuredClone(incoming), source, closed: bucket.closed };
      const key = rowKey(row);
      const stored = this.#rows.get(key);
      if (stored) {
        if (figures(stored) !== figures(row)) breaches += 1;
        continue;
      }
      const org = organisationOf(row.subject);
      this.#rows.set(key, org && tenants.has(org) ? { ...row, tenant: org } : row);
    }
    if (closedThrough !== undefined) await this.advance(source, closedThrough);
    return { breaches };
  }

  async advance(source: string, closedThrough: string) {
    const current = this.#marks.get(source);
    if (!current || closedThrough > current) this.#marks.set(source, closedThrough);
  }

  async tenantRows(tenants: readonly string[], from: Date, to: Date) {
    const wanted = new Set(tenants);
    return [...this.#rows.values()]
      .filter(
        (r): r is AssignedUsageRow =>
          'tenant' in r &&
          wanted.has(r.tenant) &&
          r.start >= from.toISOString() &&
          r.start < to.toISOString(),
      )
      .map((r) => structuredClone(r));
  }

  async unassignedRows(from: Date, to: Date) {
    return [...this.#rows.values()]
      .filter(
        (r) => !('tenant' in r) && r.start >= from.toISOString() && r.start < to.toISOString(),
      )
      .map((r) => structuredClone(r));
  }

  async rates() {
    return structuredClone(this.#rates);
  }

  setRates(rates: CurrencyRate[]) {
    this.#rates = structuredClone(rates);
  }

  all(): UsageRow[] {
    return [...this.#rows.values()].map((r) => structuredClone(r));
  }
}
