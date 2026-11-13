import { describe, expect, it } from 'vitest';
import { boundYears, currentYear, FIRST_YEAR, withinYears } from './years.js';

const values = (field: { options: readonly { value: string }[] }) =>
  field.options.map((option) => option.value);

const noisy = {
  id: 'concerned_years',
  label: 'År',
  kind: 'year' as const,
  options: ['12', '1899', '1900', '1990', '2025', '2026', '2027', '2252', 'n.d.'].map((value) => ({
    value,
    count: 1,
  })),
};

describe('the years a year field offers', () => {
  it('runs from 1900 up to this year, newest first, when the profile names no bounds', () => {
    expect(FIRST_YEAR).toBe(1900);
    expect(values(boundYears(noisy, undefined, [], 2026))).toEqual([
      '2026',
      '2025',
      '1990',
      '1900',
    ]);
  });

  it('runs from the profile’s first year to its last', () => {
    expect(values(boundYears(noisy, { first: 1990, last: 2025 }, [], 2026))).toEqual([
      '2025',
      '1990',
    ]);
    expect(values(boundYears(noisy, { first: 1990 }, [], 2027))).toEqual([
      '2027',
      '2026',
      '2025',
      '1990',
    ]);
  });

  it('keeps a value the reader chose, whatever it is, so its chip can be removed', () => {
    expect(values(boundYears(noisy, { first: 1990 }, ['2252', 'n.d.'], 2026))).toEqual([
      '2252',
      '2026',
      '2025',
      '1990',
      'n.d.',
    ]);
  });

  it('leaves a field that is not a year field as it is', () => {
    const type = { id: 'type', label: 'Dokumenttyper', options: [{ value: '12', count: 1 }] };
    expect(boundYears(type, { first: 1990 }, [], 2026)).toBe(type);
  });

  it('bounds each year field by its own spec, and the chosen values of that field only', () => {
    const other = { ...noisy, id: 'published' };
    const [first, second] = withinYears(
      [noisy, other],
      [
        { id: 'concerned_years', label: 'År', kind: 'year', years: { first: 2025 } },
        { id: 'published', label: 'Publisert', kind: 'year' },
      ],
      { published: ['2252'] },
      2026,
    );
    expect(values(first ?? noisy)).toEqual(['2026', '2025']);
    expect(values(second ?? noisy)).toEqual(['2252', '2026', '2025', '1990', '1900']);
  });

  it('reads a long value from genki in linear time, as no year', () => {
    const long = { ...noisy, options: [{ value: '1'.repeat(200_000) + 'x', count: 1 }] };
    const started = performance.now();
    expect(values(boundYears(long, undefined, [], 2026))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('takes this year as it is in Norway, not on the machine’s clock', () => {
    // 23:30 UTC on New Year's Eve is half past midnight in Oslo.
    expect(currentYear(new Date('2026-12-31T23:30:00Z'))).toBe(2027);
    expect(currentYear(new Date('2026-12-31T22:30:00Z'))).toBe(2026);
  });
});
