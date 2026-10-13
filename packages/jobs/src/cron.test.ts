import { describe, expect, it } from 'vitest';
import { CronError, nextRun, parseCron } from './cron.js';

const next = (expression: string, after: string, timeZone = 'Europe/Oslo') =>
  nextRun(parseCron(expression), new Date(after), timeZone).toISOString();

describe('cron', () => {
  it('finds the next weekday morning in Oslo time', () => {
    expect(next('30 7 * * 1-5', '2026-10-09T08:00:00Z')).toBe('2026-10-12T05:30:00.000Z');
  });

  it('steps through minutes and keeps to the hour across DST', () => {
    expect(next('*/15 * * * *', '2026-10-06T10:07:00Z')).toBe('2026-10-06T10:15:00.000Z');
    expect(next('0 3 * * *', '2026-10-24T12:00:00Z')).toBe('2026-10-25T02:00:00.000Z');
    expect(next('0 3 * * *', '2026-03-28T12:00:00Z')).toBe('2026-03-29T01:00:00.000Z');
  });

  it('skips a local time that does not exist on the spring-forward night', () => {
    expect(next('30 2 * * *', '2026-03-28T12:00:00Z')).toBe('2026-03-30T00:30:00.000Z');
  });

  it('treats day of month and weekday as either-or when both are set', () => {
    expect(next('0 9 1 * 1', '2026-10-06T12:00:00Z')).toBe('2026-10-12T07:00:00.000Z');
  });

  it('runs in UTC when asked', () => {
    expect(next('0 0 1 1 *', '2026-10-06T00:00:00Z', 'UTC')).toBe('2027-01-01T00:00:00.000Z');
  });

  it.each(['* * * *', '61 * * * *', '* 24 * * *', '*/0 * * * *', 'a b c d e', '5-1 * * * *'])(
    'refuses %j',
    (expression) => {
      expect(() => parseCron(expression)).toThrow(CronError);
    },
  );
});
