import { createFormat, type Format } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { translator } from './i18n.js';
import { answerTime } from './time.js';

const nb = createFormat('nb');
const en = createFormat('en');
// 14.00 in Oslo on Tuesday 15 September 2026.
const now = new Date('2026-09-15T12:00:00Z');
// The words from the catalogue, as AnswerTime passes them.
const words = (f: Format) => {
  const t = translator(f.locale);
  return {
    yesterday: t('conversation.yesterday'),
    dateTime: (date: string, time: string) => t('conversation.dateTime', { date, time }),
  };
};
const when = (at: string, f = nb, from = now) => answerTime(at, f, words(f), from);
const text = (at: string, f = nb) => when(at, f)?.text;

describe('when an answer came', () => {
  it('is the clock today, as the thread list writes a row from today', () => {
    expect(text('2026-09-15T12:32:00Z')).toBe('14:32');
  });

  it('writes the clock with a colon, «14:32», as kunnskapsassistenten does, in every language', () => {
    expect(text('2026-09-15T12:32:00Z', en)).toBe('14:32');
    expect(when('2026-09-15T07:05:00Z', en)?.title).toBe('15 September 2026, 09:05');
  });

  it('is «i går» the day before, the weekday this week, and day and month after that', () => {
    expect(text('2026-09-14T07:05:00Z')).toBe('i går');
    expect(text('2026-09-11T07:05:00Z')).toBe('fredag');
    expect(text('2026-08-28T07:05:00Z')).toBe('28. aug.');
    expect(text('2025-05-12T07:05:00Z')).toBe('12. mai');
  });

  it('carries the machine date and the whole date, in the catalogue’s words', () => {
    expect(when('2025-05-12T07:05:00Z')).toEqual({
      text: '12. mai',
      dateTime: '2025-05-12T07:05:00.000Z',
      title: '12. mai 2025 kl. 09:05',
    });
  });

  it('counts calendar days on Oslo’s clock, not in hours or in UTC', () => {
    const justAfterMidnight = new Date('2026-09-14T22:30:00Z');
    // 23.30 the evening before in Oslo, though the same date in UTC.
    expect(when('2026-09-14T21:30:00Z', nb, justAfterMidnight)?.text).toBe('i går');
  });

  it('reads a time ahead of the clock as today, rather than arguing with the clock', () => {
    expect(text('2026-09-15T20:00:00Z')).toBe('22:00');
  });

  it('gives up quietly on a time it cannot read', () => {
    expect(when('ikke en dato')).toBeUndefined();
  });

  it('speaks the reader’s language', () => {
    expect(text('2026-09-11T07:05:00Z', en)).toBe('Friday');
    expect(text('2026-09-14T07:05:00Z', en)).toBe('yesterday');
    expect(text('2026-08-28T07:05:00Z', en)).toBe('28 Aug');
  });
});
