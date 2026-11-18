import { describe, expect, it } from 'vitest';
import type { UsageReport, UsageTotals } from '../../types';
import { ingestionRow, monthUsage, trialRow, withTrialRows } from './model';

const u = (tokens: number): UsageTotals => ({
  inputTokens: tokens,
  outputTokens: 0,
  requests: 1,
  costMicroNok: tokens,
});

const day = (date: string): UsageReport['daily'][number] => ({
  date,
  usage: u(1000),
  byService: { postsortering: u(600) },
  testing: u(150),
  ingestion: u(250),
});

const report: UsageReport = {
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-02T12:00:00Z',
  priced: true,
  totals: u(2000),
  daily: [day('2026-10-01'), day('2026-10-02')],
  byService: [{ service: 'postsortering', usage: u(1200) }],
  byModel: [],
  ingestion: { usage: u(500) },
};

describe('Statistikk: testing og innlesing per dag', () => {
  it('counts each day’s ingestion as its own row, not as trial runs', () => {
    const first = withTrialRows(report).daily[0]?.byService ?? {};
    expect(first[ingestionRow]?.inputTokens).toBe(250);
    expect(first[trialRow]?.inputTokens).toBe(150);
  });

  it('keeps the month’s parts adding up to the month’s total', () => {
    const month = monthUsage(withTrialRows(report));
    expect(month.services.inputTokens).toBe(1200);
    expect(month.trial.inputTokens).toBe(300);
    expect(month.ingestion.inputTokens).toBe(500);
    expect(month.total.inputTokens).toBe(2000);
  });

  it('splits ingestion out of the whole period too', () => {
    const rows = withTrialRows(report).byService;
    expect(rows.find((r) => r.service === ingestionRow)?.usage.inputTokens).toBe(500);
    expect(rows.find((r) => r.service === trialRow)?.usage.inputTokens).toBe(300);
  });
});
