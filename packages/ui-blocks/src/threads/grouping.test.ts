import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { groupThreads, rowTime, type ThreadGroup } from './grouping.js';
import type { ThreadItem } from './types.js';

// The tests run in Oslo time (vitest.config.ts), so these are Oslo's calendar days.
const now = new Date(2026, 8, 11, 12, 0, 0);

const thread = (id: string, date: Date | string | number): ThreadItem => ({
  id,
  title: id,
  updatedAt: date,
});

const daysBefore = (days: number, hour = 9) => {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  date.setHours(hour, 0, 0, 0);
  return thread(`t${days}`, date);
};

const periods = (groups: ThreadGroup[]) =>
  groups.map((g) =>
    g.period === 'year' ? g.year : g.period === 'month' ? g.date.getMonth() : g.period,
  );

describe('grouping threads by period', () => {
  it('follows the periods decided: today, 7 days, 30 days, the months of this year, then years', () => {
    const groups = groupThreads(
      [daysBefore(0), daysBefore(3), daysBefore(20), daysBefore(48), daysBefore(310)],
      now,
    );
    expect(periods(groups)).toEqual(['today', 'last7', 'last30', 6, 2025]);
  });

  it('treats «i dag» as the calendar day, not the last 24 hours', () => {
    const earlyToday = new Date(2026, 8, 11, 0, 30);
    const lateYesterday = new Date(2026, 8, 10, 23, 30);
    const groups = groupThreads([thread('early', earlyToday), thread('late', lateYesterday)], now);
    expect(periods(groups)).toEqual(['today', 'last7']);
  });

  it('puts day 6 in «Siste 7 dager» and day 7 in «Siste 30 dager»', () => {
    expect(periods(groupThreads([daysBefore(6), daysBefore(7)], now))).toEqual(['last7', 'last30']);
  });

  it('names months only for the current year', () => {
    expect(periods(groupThreads([thread('new-year', new Date(2026, 0, 1))], now))).toEqual([0]);
  });

  it('collects everything from an earlier year under that year, newest first', () => {
    const groups = groupThreads(
      [thread('march', new Date(2025, 2, 4)), thread('december', new Date(2025, 11, 20))],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.year).toBe(2025);
    expect(groups[0]?.threads.map((t) => t.id)).toEqual(['december', 'march']);
  });

  it('sorts newest first, whatever order it is given', () => {
    const groups = groupThreads([daysBefore(310), daysBefore(0), daysBefore(3)], now);
    expect(periods(groups)).toEqual(['today', 'last7', 2025]);
  });

  it('keeps a thread dated in the future in «I dag» rather than dropping it', () => {
    expect(periods(groupThreads([thread('future', new Date(2026, 8, 12))], now))).toEqual([
      'today',
    ]);
  });

  it('gives two threads from the same millisecond one order, whatever order they came in', () => {
    const ids = ['bravo', 'alfa', 'charlie'];
    const forwards = groupThreads(
      ids.map((id) => thread(id, now)),
      now,
    );
    const backwards = groupThreads(
      [...ids].reverse().map((id) => thread(id, now)),
      now,
    );
    expect(forwards[0]?.threads.map((t) => t.id)).toEqual(['alfa', 'bravo', 'charlie']);
    expect(backwards[0]?.threads.map((t) => t.id)).toEqual(['alfa', 'bravo', 'charlie']);
  });

  it('reads ISO text, epoch milliseconds and dates alike', () => {
    const at = new Date(2026, 8, 11, 9);
    const groups = groupThreads(
      [thread('iso', at.toISOString()), thread('ms', at.getTime()), thread('date', at)],
      now,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads).toHaveLength(3);
  });

  it('puts a thread whose time cannot be read last, in a group of its own', () => {
    const groups = groupThreads([thread('broken', 'ikke en dato'), daysBefore(0)], now);
    expect(periods(groups)).toEqual(['today', 'undated']);
  });

  it('returns nothing for an empty list', () => {
    expect(groupThreads([], now)).toEqual([]);
  });
});

/** A Tuesday, so the weekday cases are not all the same day. */
const tuesday = new Date(2026, 8, 15, 14, 0, 0);
const at = (...args: [number, number, number, number?, number?]) => new Date(...args).toISOString();
const nb = createFormat('nb');
const en = createFormat('en');

describe('the time on a row', () => {
  it('shows the clock for today, since the heading already says «I dag»', () => {
    expect(rowTime(at(2026, 8, 15, 14, 32), nb, 'i går', tuesday)?.text).toBe('14:32');
  });

  it('writes the clock with a colon, as kunnskapsassistenten does, in every language', () => {
    expect(rowTime(at(2026, 8, 15, 9, 5), nb, 'i går', tuesday)?.text).toBe('09:05');
    expect(rowTime(at(2026, 8, 15, 9, 5), en, 'yesterday', tuesday)?.text).toBe('09:05');
  });

  it('says «i går» rather than naming the weekday', () => {
    expect(rowTime(at(2026, 8, 14, 9, 5), nb, 'i går', tuesday)?.text).toBe('i går');
  });

  it('names the weekday inside «Siste 7 dager»', () => {
    expect(rowTime(at(2026, 8, 11, 9, 5), nb, 'i går', tuesday)?.text).toBe('fredag');
  });

  it('switches to day and month once the weekday stops being enough', () => {
    expect(rowTime(at(2026, 7, 28, 9, 5), nb, 'i går', tuesday)?.text).toBe('28. aug.');
  });

  it('writes day and month in the month and year groups, since the heading has the year', () => {
    expect(rowTime(at(2026, 6, 12, 9, 5), nb, 'i går', tuesday)?.text).toBe('12. juli');
    expect(rowTime(at(2025, 4, 12, 9, 5), nb, 'i går', tuesday)?.text).toBe('12. mai');
  });

  it('carries the machine date and the whole date, whatever the short text says', () => {
    const iso = at(2025, 4, 12, 9, 5);
    const time = rowTime(iso, nb, 'i går', tuesday);
    expect(time?.dateTime).toBe(iso);
    expect(time?.title).toBe('12. mai 2025 kl. 09:05');
    expect(rowTime(iso, en, 'yesterday', tuesday)?.title).toBe('12 May 2025, 09:05');
  });

  it('speaks English when the person does', () => {
    expect(rowTime(at(2026, 8, 11, 9, 5), en, 'yesterday', tuesday)?.text).toBe('Friday');
    expect(rowTime(at(2026, 6, 12, 9, 5), en, 'yesterday', tuesday)?.text).toBe('12 July');
  });

  it('gives up quietly on a timestamp it cannot read', () => {
    expect(rowTime('ikke en dato', nb, 'i går', tuesday)).toBeUndefined();
  });

  it('never contradicts the group heading it sits under', () => {
    const threads = [
      thread('a', at(2026, 8, 15, 14, 32)),
      thread('b', at(2026, 8, 14, 9, 5)),
      thread('c', at(2026, 8, 11, 9, 5)),
      thread('d', at(2026, 7, 28, 9, 5)),
      thread('e', at(2026, 6, 12, 9, 5)),
      thread('f', at(2025, 4, 12, 9, 5)),
    ];
    const labelled = groupThreads(threads, tuesday).map((group) => [
      group.period,
      ...group.threads.map((t) => rowTime(t.updatedAt, nb, 'i går', tuesday)?.text),
    ]);
    expect(labelled).toEqual([
      ['today', '14:32'],
      ['last7', 'i går', 'fredag'],
      ['last30', '28. aug.'],
      ['month', '12. juli'],
      ['year', '12. mai'],
    ]);
  });
});
