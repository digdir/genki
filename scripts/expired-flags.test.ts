import { describe, expect, it } from 'vitest';
import { reportExpiredFlags } from './expired-flags.ts';

const registry = {
  trial: { description: 'x', owner: 'the lab', removeBy: '2027-02-28', selfService: false },
  later: { description: 'x', owner: 'the lab', removeBy: '2027-12-31', selfService: false },
};

describe('the expired flag report', () => {
  it('says so and exits 0 when no flag is past its removeBy date, also in strict mode', () => {
    const now = new Date('2027-02-28T20:00:00Z');

    expect(reportExpiredFlags(now, registry, false).exitCode).toBe(0);
    expect(reportExpiredFlags(now, registry, true)).toEqual({
      lines: ['No feature flag is past its removeBy date.'],
      exitCode: 0,
    });
  });

  it('prints one warning annotation per expired flag and exits 0 without strict', () => {
    const report = reportExpiredFlags(new Date('2027-03-01T10:00:00Z'), registry, false);

    expect(report).toEqual({
      lines: [
        '::warning file=packages/contracts/src/flags.ts::Feature flag trial (owner the lab) passed its removeBy date 2027-02-28: remove it or move the date',
      ],
      exitCode: 0,
    });
  });

  it('exits 1 in strict mode when a flag has expired', () => {
    expect(reportExpiredFlags(new Date('2027-03-01T10:00:00Z'), registry, true).exitCode).toBe(1);
  });
});
