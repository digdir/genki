import {
  gatewayUsageSource,
  requestProblems,
  UsageGatewayError,
  rfc3339,
  type GatewayGroup,
  type GatewayUsageAnswer,
  type GatewayUsageFigures,
  type GatewayUsageRequest,
  type UsageGateway,
  type UsageQuery,
  type UsageRow,
  type UsageSource,
} from './usage.js';

export interface FakeCall {
  client: string;
  org?: string;
  model: string;
  responseModel?: string;
  provider?: string;
  at: Date | string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costMicros?: number;
  httpStatus?: number;
}

interface RecordedCall {
  at: number;
  model: string;
  responseModel: string;
  provider: string;
  org: string | undefined;
  client: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicros: number;
  httpStatus: number;
}

export interface MemoryUsageOptions {
  id?: string;
  now?: () => Date;
  genkiClients?: readonly string[];
  settleMs?: number;
}

interface Sum {
  group: GatewayGroup;
  figures: GatewayUsageFigures;
  costMicros: number;
}

export class MemoryUsageSource implements UsageSource, UsageGateway {
  readonly id: string;
  readonly #calls: RecordedCall[] = [];
  readonly #source: UsageSource;
  readonly seen: GatewayUsageRequest[] = [];

  constructor(options: MemoryUsageOptions = {}) {
    this.id = options.id ?? 'gateway';
    this.#source = gatewayUsageSource(this.id, this, {
      ...(options.genkiClients ? { genkiClients: options.genkiClients } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    });
  }

  record(call: FakeCall) {
    this.#calls.push({
      at: new Date(call.at).getTime(),
      model: call.model,
      responseModel: call.responseModel ?? call.model,
      provider: call.provider ?? 'azure',
      org: call.org,
      client: call.client,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens ?? 0,
      cacheWriteTokens: call.cacheWriteTokens ?? 0,
      costMicros: call.costMicros ?? 0,
      httpStatus: call.httpStatus ?? 200,
    });
  }

  usage(query: UsageQuery): Promise<{ rows: UsageRow[]; next: string | null }> {
    return this.#source.usage(query);
  }

  async query(request: GatewayUsageRequest): Promise<GatewayUsageAnswer> {
    this.seen.push(structuredClone(request));
    const problems = requestProblems(request);
    if (problems.length > 0)
      throw new UsageGatewayError(403, 'the request breaks the usage rules', problems);
    const from = Date.parse(request.timeRange.from);
    const to = Date.parse(request.timeRange.to);
    const step = request.bucketSeconds * 1000;
    const statuses = request.filters?.httpStatus;
    const wanted = Object.entries(request.filters?.attributes ?? {});
    const totals = new Map<string, Sum>();
    const buckets = new Map<string, Sum & { start: number }>();
    const add = <T extends Sum>(
      into: Map<string, T>,
      key: string,
      fresh: () => T,
      c: RecordedCall,
    ) => {
      const sum = into.get(key) ?? fresh();
      sum.figures.requests += 1;
      sum.figures.inputTokens += c.inputTokens;
      sum.figures.outputTokens += c.outputTokens;
      sum.figures.totalTokens += c.inputTokens + c.outputTokens;
      sum.figures.cacheReadTokens += c.cacheReadTokens;
      sum.figures.cacheWriteTokens += c.cacheWriteTokens;
      sum.costMicros += c.costMicros;
      into.set(key, sum);
    };
    for (const c of this.#calls) {
      if (c.at < from || c.at >= to) continue;
      if (statuses && !statuses.includes(c.httpStatus)) continue;
      const attributes: Record<string, string | undefined> = {
        'usage.org': c.org,
        'usage.client': c.client,
      };
      if (wanted.some(([k, v]) => attributes[k] !== v)) continue;
      const group: GatewayGroup = {};
      for (const g of request.groupBy ?? []) {
        if (g.field === 'provider') group.provider = c.provider;
        else if (g.field === 'requestModel') group.requestModel = c.model;
        else if (g.field === 'responseModel') group.responseModel = c.responseModel;
        else if (g.field === 'attributes') group[g.key] = attributes[g.key] ?? null;
      }
      const key = JSON.stringify(Object.entries(group).sort(([a], [b]) => a.localeCompare(b)));
      const start = from + Math.floor((c.at - from) / step) * step;
      const fresh = () => ({
        group: { ...group },
        figures: {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        },
        costMicros: 0,
      });
      add(totals, key, fresh, c);
      add(buckets, `${start}\u0000${key}`, () => ({ ...fresh(), start }), c);
    }
    const flat = ({ group, figures, costMicros }: Sum) => ({
      group,
      ...figures,
      cost: costMicros / 1_000_000,
    });
    const byKey = <T>(sums: Map<string, T>) =>
      [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([, sum]) => sum);
    return {
      timeRange: request.timeRange,
      bucketSeconds: request.bucketSeconds,
      buckets: byKey(buckets)
        .sort((a, b) => a.start - b.start)
        .map((b) => ({ start: rfc3339(new Date(b.start)), ...flat(b) })),
      groups: byKey(totals).map(flat),
    };
  }
}

export const memoryUsageSource = (options: MemoryUsageOptions = {}) =>
  new MemoryUsageSource(options);
