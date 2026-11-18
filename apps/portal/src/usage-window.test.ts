import { describe, expect, it } from 'vitest';
import { daysThisMonth } from './usage-window';

describe('the usage window for this month', () => {
  it('counts the days of the month in Oslo time, so just after midnight in Oslo is a new day', () => {
    expect(daysThisMonth(new Date('2026-11-17T22:59:00Z'))).toBe(17);
    expect(daysThisMonth(new Date('2026-11-17T23:04:00Z'))).toBe(18);
  });

  it('starts the new month at midnight in Oslo, not at midnight UTC', () => {
    expect(daysThisMonth(new Date('2026-11-30T23:30:00Z'))).toBe(1);
    expect(daysThisMonth(new Date('2026-06-30T22:30:00Z'))).toBe(1);
  });
});
