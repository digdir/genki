import type { Money, UsageRow } from './usage.js';

export const genkiSource = 'genki';

export interface CountingRule {
  throughGateway(model: string): boolean;
}

/** Step 1: no genki endpoint runs through the gateway. */
export const directOnly: CountingRule = { throughGateway: () => false };

const routed = (model: string | undefined, rule: CountingRule) =>
  model !== undefined && rule.throughGateway(model);

/** Whether genki's own measured cost for a model counts, or the gateway's charge replaces it. */
export const genkiCostCounts = (model: string | undefined, rule: CountingRule = directOnly) =>
  !routed(model, rule);

const isGenkiCallInGateway = (row: UsageRow) =>
  row.source !== genkiSource && row.subject?.kind === 'genki';

/** The rows that count, so each call is counted once whichever source measured it. */
export const combine = (rows: readonly UsageRow[], rule: CountingRule = directOnly): UsageRow[] =>
  rows.flatMap((row) => {
    if (row.source === genkiSource)
      return genkiCostCounts(row.model, rule)
        ? [row]
        : [{ ...row, unpricedRequests: 0, cost: { currency: row.cost.currency, micros: 0 } }];
    if (!isGenkiCallInGateway(row)) return [row];
    if (!routed(row.model, rule)) return [];
    return [
      {
        ...row,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
      },
    ];
  });

export interface UsageSum {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  unpricedRequests: number;
  cost: Money[];
}

export const sumUsage = (rows: readonly UsageRow[]): UsageSum => {
  const cost = new Map<string, number>();
  const sum = { inputTokens: 0, outputTokens: 0, requests: 0, unpricedRequests: 0 };
  for (const row of rows) {
    sum.inputTokens += row.inputTokens;
    sum.outputTokens += row.outputTokens;
    sum.requests += row.requests;
    sum.unpricedRequests += row.unpricedRequests;
    cost.set(row.cost.currency, (cost.get(row.cost.currency) ?? 0) + row.cost.micros);
  }
  return {
    ...sum,
    cost: [...cost]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, micros]) => ({ currency, micros })),
  };
};
