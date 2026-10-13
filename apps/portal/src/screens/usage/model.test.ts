import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import type { UsageReport, UsageTotals } from '../../types';
import { aggregate, costOf, monthStatus, runsOf, series } from './model';

const f = createFormat('nb');
const t = translator('nb');

const u = (tokens: number, nok: number, requests: number, runs?: number): UsageTotals => ({
  inputTokens: tokens,
  outputTokens: 0,
  requests,
  ...(runs === undefined ? {} : { runs }),
  costMicroNok: nok * 1e6,
  priced: true,
});

const report: UsageReport = {
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-02T12:00:00Z',
  priced: true,
  totals: u(3000, 12, 30, 3),
  daily: [
    {
      date: '2026-10-01',
      usage: u(2000, 11, 20),
      byService: { dyr: u(1000, 10, 15, 1), billig: u(500, 1, 5, 1) },
      byModel: { stor: u(1000, 10, 15), liten: u(500, 1, 5) },
    },
    {
      date: '2026-10-02',
      usage: u(1000, 1, 10),
      byService: { billig: u(1000, 1, 10, 1) },
      byModel: { liten: u(1000, 1, 10) },
    },
  ],
  byService: [
    { service: 'dyr', usage: u(1000, 10, 15, 1) },
    { service: 'billig', usage: u(1500, 2, 15, 2) },
  ],
  byModel: [
    { model: 'stor', usage: u(1000, 10, 15) },
    { model: 'liten', usage: u(1500, 2, 15) },
  ],
};

describe('usage model', () => {
  it('uses the cost the API gives per service and model each day instead of spreading the total by tokens', () => {
    const services = aggregate(series(report, 'current', 'service', f, t));
    expect(services.dyr && costOf(services.dyr)).toBe(10);
    expect(services.billig && costOf(services.billig)).toBe(2);
    const models = aggregate(series(report, 'current', 'model', f, t));
    expect(models.stor && costOf(models.stor)).toBe(10);
  });

  it('counts runs as tasks, not model requests', () => {
    const status = monthStatus(report, null, null, f, t);
    expect(status.runs).toBe(3);
    expect(runsOf(u(1, 0, 7))).toBe(7);
  });

  it('takes the month total from the daily totals, so usage outside services still counts', () => {
    const status = monthStatus(report, null, null, f, t);
    expect(status.used).toBe(3000);
    expect(status.cost).toBe(12);
  });
});
