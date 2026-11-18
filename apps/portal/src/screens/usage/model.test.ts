import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import type { UsageReport, UsageTotals } from '../../types';
import { zeroUsage } from '../../data/usage';
import {
  add,
  aggregate,
  COLORS,
  costOf,
  costText,
  isLowerBound,
  knownCostOf,
  monthOptions,
  monthStatus,
  periodOf,
  runsOf,
  series,
} from './model';

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
    const services = aggregate(series(report, 0, 'service', f, t));
    expect(services.dyr && costOf(services.dyr)).toBe(10);
    expect(services.billig && costOf(services.billig)).toBe(2);
    const models = aggregate(series(report, 0, 'model', f, t));
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

describe('chart colours', () => {
  it('gives each of the first 15 series its own fill, so no two services share a colour', () => {
    expect(new Set(COLORS).size).toBe(15);
  });

  it('builds every fill from Designsystemet tokens that read on both light and dark backgrounds', () => {
    for (const fill of COLORS) {
      expect(fill).not.toMatch(/#|rgb/);
      expect(fill).not.toMatch(/-base-default/);
      expect(fill).toMatch(/var\(--ds-color-[a-z0-9]+-border-default\)/);
    }
  });
});

describe('cost with a model that has no price', () => {
  const unpriced = (tokens: number): UsageTotals => ({
    inputTokens: tokens,
    outputTokens: 0,
    requests: 1,
    costMicroNok: null,
    priced: false,
  });

  it('keeps the priced part of a sum and marks it as at least that much', () => {
    const sum = add(u(1000, 12, 1), unpriced(500));
    expect(knownCostOf(sum)).toBe(12);
    expect(isLowerBound(sum)).toBe(true);
    expect(costText(f, t, sum)).toBe('minst 12 kr');
  });

  it('says Ikke priset, never minst 0 kr, when nothing in the sum has a price', () => {
    const sum = add(add(zeroUsage(), unpriced(500)), unpriced(200));
    expect(costText(f, t, sum)).toBe('Ikke priset');
  });

  it('a fully priced sum is shown as it is, without minst', () => {
    expect(costText(f, t, add(zeroUsage(), u(1000, 12, 1)))).toBe('12 kr');
  });

  it('reads the month in the address as months back, and falls back to this month outside the six shown', () => {
    expect(periodOf(report, null)).toBe(0);
    expect(periodOf({ ...report, to: '2026-11-18T10:00:00Z' }, '2026-10')).toBe(1);
    expect(periodOf({ ...report, to: '2026-11-18T10:00:00Z' }, '2026-04')).toBe(0);
    expect(periodOf({ ...report, to: '2026-11-18T10:00:00Z' }, 'tull')).toBe(0);
    expect(monthOptions({ ...report, to: '2026-11-18T10:00:00Z' }, f).map((o) => o.value)).toEqual([
      '2026-11',
      '2026-10',
      '2026-09',
      '2026-08',
      '2026-07',
      '2026-06',
    ]);
  });
});
