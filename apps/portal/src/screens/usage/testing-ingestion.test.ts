import { describe, expect, it } from 'vitest';
import type { UsageReport, UsageTotals } from '../../types';
import { createFormat } from '@genai/i18n';
import { translator } from '../../i18n';
import {
  ingestionRow,
  internalRow,
  monthStatus,
  monthUsage,
  trialRow,
  withTrialRows,
} from './model';

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

describe('the monthly quota', () => {
  const withInternal: UsageReport = {
    ...report,
    totals: u(2400),
    daily: [
      { ...day('2026-10-01'), usage: u(1200), internal: u(200) },
      { ...day('2026-10-02'), usage: u(1200), internal: u(200) },
    ],
    internal: { usage: u(400) },
  };

  it('counts runs of internal services in their own row, not as trial runs', () => {
    const folded = withTrialRows(withInternal);
    const first = folded.daily[0]?.byService ?? {};
    expect(first[internalRow]?.inputTokens).toBe(200);
    expect(first[trialRow]?.inputTokens).toBe(150);
    expect(folded.byService.find((r) => r.service === internalRow)?.usage.inputTokens).toBe(400);
  });

  it('counts internal services among the services, and leaves ingestion out of the quota', () => {
    const month = monthUsage(withTrialRows(withInternal));
    expect(month.services.inputTokens).toBe(1600);
    expect(month.quotaTokens).toBe(1900);
  });

  it('leaves the AI gateway out of the quota', () => {
    const viaGateway: UsageReport = {
      ...report,
      daily: report.daily.map((d) => ({
        ...d,
        usage: { ...d.usage, bySource: [{ source: 'gateway', usage: u(100) }] },
      })),
    };
    expect(monthUsage(viaGateway).quotaTokens).toBe(1300);
  });

  it('shows the used quota the API counts, the number that blocks services', () => {
    const counted = {
      ...report,
      quota: {
        usedTokens: 1777,
        monthlyTokens: 10_000,
        usedPercent: 17.8,
        alertPercent: 80,
        alert: false,
      },
    };
    const status = monthStatus(counted, 10_000, null, createFormat('nb'), translator('nb'));
    expect(status.used).toBe(1777);
  });

  it('keeps a project view to its own usage, not the tenant-wide quota', () => {
    const scoped = {
      ...report,
      project: 'p1',
      quota: {
        usedTokens: 9999,
        monthlyTokens: 10_000,
        usedPercent: 99,
        alertPercent: 80,
        alert: true,
      },
    };
    const status = monthStatus(scoped, 10_000, null, createFormat('nb'), translator('nb'));
    expect(status.used).toBe(1500);
  });

  it('forecasts the cost from all spent tokens, ingestion included', () => {
    const status = monthStatus(report, 10_000, null, createFormat('nb'), translator('nb'));
    expect(status.forecastCost).toBeCloseTo((2000 / 1e6) * (31 / 2), 9);
  });

  it('forecasts the month from the tokens the quota counts', () => {
    const status = monthStatus(report, 10_000, null, createFormat('nb'), translator('nb'));
    expect(status.used).toBe(1500);
    expect(status.forecast).toBe(1500 + 750 * 29);
  });
});
