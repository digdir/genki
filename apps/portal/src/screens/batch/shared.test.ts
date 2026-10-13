import { describe, expect, it } from 'vitest';
import { shownValues } from './shared';

describe('shownValues', () => {
  it('lists only plausible years, newest first, for a year filter', () => {
    const values = ['2438', '2024', '2176', '2050', '1850', 'ukjent', '2026', '2019'].map(
      (value, i) => ({ value, count: i + 1 }),
    );
    expect(
      shownValues('concerned_years', values, new Date('2026-10-12')).map((v) => v.value),
    ).toEqual(['2026', '2024', '2019']);
  });

  it('keeps other filters as the API gives them', () => {
    const values = [{ value: 'Årsrapport', count: 3 }];
    expect(shownValues('type', values)).toBe(values);
  });
});
