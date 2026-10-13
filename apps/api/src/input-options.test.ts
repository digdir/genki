import { describe, expect, it } from 'vitest';
import type { InputField } from '@genai/contracts';
import { facetChoices } from './input-options.js';

const now = new Date('2026-10-08T12:00:00Z');
const counts = (...pairs: [string, number][]) => pairs.map(([value, count]) => ({ value, count }));
const field = (kind: InputField['kind'], from: Partial<InputField['optionsFrom']> = {}) =>
  ({
    id: 'f',
    label: 'Felt',
    kind,
    optionsFrom: { dataset: 'digdir/kudos', facet: 'x', ...from },
  }) as InputField;

describe('options drawn from a facet', () => {
  it('lists organisations with the most documents first', () => {
    expect(
      facetChoices(
        field('multi-choice'),
        counts(['Udir', 3], ['Digdir', 12], ['Arkivverket', 3], ['', 9]),
        now,
      ),
    ).toEqual(['Digdir', 'Arkivverket', 'Udir']);
  });

  it('keeps only years from 1900 to next year, newest first, also when the field is not a year field', () => {
    const years = counts(
      ['2019', 5],
      ['2425', 1],
      ['2025', 9],
      ['1850', 1],
      ['2027', 1],
      ['2035', 3],
      ['2438', 2],
    );
    expect(facetChoices(field('year'), years, now)).toEqual(['2027', '2025', '2019']);
    expect(facetChoices(field('multi-choice'), years, now)).toEqual(['2027', '2025', '2019']);
  });

  it('applies min, max and pattern from the definition', () => {
    const years = counts(['2019', 5], ['2023', 1], ['2025', 9]);
    expect(facetChoices(field('choice', { min: 2020, max: 2024 }), years, now)).toEqual(['2023']);
    expect(
      facetChoices(
        field('choice', { pattern: '^Tilde' }),
        counts(['Tildelingsbrev', 1], ['Årsrapport', 4]),
        now,
      ),
    ).toEqual(['Tildelingsbrev']);
  });
});
