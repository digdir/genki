import type { Event, Usage } from '@genai/contracts';

export interface TokenPrice {
  inputPerThousand: number;
  outputPerThousand: number;
}

export interface MonthlyTokenQuota {
  monthlyTokens(tenant: string): number;
  usedTokens(tenant: string, since: string): Promise<number>;
  now?: () => Date;
}

export type Admission =
  { ok: true; budget?: Usage } | { ok: false; code: 'quota_exhausted'; error: string };

export interface RunCost {
  usage: { inputTokens: number; outputTokens: number };
  costMicroNok?: number;
}

export const monthStart = (at: Date) =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();

export const quotaExhaustedMessage = 'the monthly token quota is used up';

export const assistantCapabilityPrefix = 'platform/draft/assistant/';

export const monthlyQuotaGate =
  (quota: MonthlyTokenQuota) =>
  async (tenant: string): Promise<Admission> => {
    const since = monthStart(quota.now?.() ?? new Date());
    const left = quota.monthlyTokens(tenant) - (await quota.usedTokens(tenant, since));
    if (left <= 0) return { ok: false, code: 'quota_exhausted', error: quotaExhaustedMessage };
    return { ok: true, budget: { inputTokens: left, outputTokens: left } };
  };

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);

export const costOf = async (
  events: AsyncIterable<Event>,
  prices: Record<string, TokenPrice | undefined>,
): Promise<RunCost> => {
  const usage = { inputTokens: 0, outputTokens: 0 };
  let micro = 0;
  let priced = true;
  for await (const event of events) {
    if (event.type !== 'kernel.usage') continue;
    const data = record(event.data);
    const used = record(data.usage);
    const input = count(used.inputTokens);
    const output = count(used.outputTokens);
    usage.inputTokens += input;
    usage.outputTokens += output;
    const model = record(data.model).id;
    const price = typeof model === 'string' ? prices[model] : undefined;
    if (!price) {
      if (input + output > 0) priced = false;
      continue;
    }
    micro +=
      ((input / 1000) * price.inputPerThousand + (output / 1000) * price.outputPerThousand) *
      1_000_000;
  }
  return { usage, ...(priced ? { costMicroNok: Math.round(micro) } : {}) };
};
