import { createFormat } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { durationBetween, formatDuration } from './format';

describe('formatDuration', () => {
  it('writes an hour or more as hours and whole minutes, in the language of the format', () => {
    expect(formatDuration(4530, createFormat('nb'))).toBe('1 t 15 min');
    expect(formatDuration(4530, createFormat('en'))).toBe('1 h 15 min');
    expect(formatDuration(7200, createFormat('nb'))).toBe('2 t 0 min');
  });

  it('keeps minutes and seconds under an hour', () => {
    expect(formatDuration(1200, createFormat('nb'))).toBe('20 min');
    expect(formatDuration(1203, createFormat('nb'))).toBe('20 min 3 s');
    expect(formatDuration(0.25, createFormat('nb'))).toBe('250 ms');
  });

  it('carries a fraction of a second into the next minute, never writing 60 s', () => {
    expect(formatDuration(1259.6, createFormat('nb'))).toBe('21 min');
    expect(formatDuration(1259.4, createFormat('nb'))).toBe('20 min 59 s');
    expect(formatDuration(3599.6, createFormat('nb'))).toBe('1 t 0 min');
  });
});

describe('durationBetween', () => {
  it('is the seconds from start to end, and nothing while the run has no end', () => {
    expect(durationBetween('2026-11-11T09:00:00Z', '2026-11-11T09:20:00Z')).toBe(1200);
    expect(durationBetween('2026-11-11T09:00:00Z', null)).toBeUndefined();
    expect(durationBetween('2026-11-11T09:00:00Z', undefined)).toBeUndefined();
    expect(durationBetween('2026-11-11T09:20:00Z', '2026-11-11T09:00:00Z')).toBeUndefined();
  });
});
