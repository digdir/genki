import { describe, expect, it } from 'vitest';
import {
  documentsIn,
  formatRange,
  listedYearsIn,
  parseYearInput,
  rangeFromKey,
  rangeKey,
  suggestPeriods,
  toRanges,
  yearsIn,
} from './yearRanges.js';

// Ported from KA's yearRanges tests, with a fixed year so they do not age.
const NOW = 2026;

describe('the text a reader types, as a period', () => {
  it.each([
    ['2021', 2021, 2021],
    ['  2021 ', 2021, 2021],
    ['2023-2028', 2023, 2028],
    ['2023–2028', 2023, 2028],
    ['2023—2028', 2023, 2028],
    ['2023 - 2028', 2023, 2028],
    ['2023 – 2028', 2023, 2028],
    ['2023 til 2028', 2023, 2028],
    ['2023 TIL 2028', 2023, 2028],
    ['2023til2028', 2023, 2028],
    ['2023 to 2028', 2023, 2028],
    ['23-28', 2023, 2028],
    ['92-00', 1992, 2000],
    ['2023–28', 2023, 2028],
    ['1998-02', 1998, 2002],
    ['23', 2023, 2023],
    ['26', 2026, 2026],
    ['27', 1927, 1927],
    ['99', 1999, 1999],
    ['00', 2000, 2000],
    ['2028-2023', 2023, 2028],
    // Two digits at the end always end after the start: 28 is 1928 in 2026.
    ['28-23', 1928, 2023],
    ['2024-2024', 2024, 2024],
  ])('reads «%s» as %i–%i', (text, from, to) => {
    expect(parseYearInput(text, NOW)).toEqual({ from, to });
  });

  it.each([
    [''],
    ['   '],
    ['202'],
    ['20234'],
    ['2'],
    ['fra 2015'],
    ['til 2010'],
    ['2015-'],
    ['-2015'],
    ['2015 og 2017'],
    ['2015, 2017'],
    ['to tusen'],
    ['2023-2028-2030'],
    ['2023 / 2028'],
  ])('reads «%s» as no period', (text) => {
    expect(parseYearInput(text, NOW)).toBeUndefined();
  });

  it('counts two digits from this year, so the border moves with time', () => {
    expect(parseYearInput('30', 2029)).toEqual({ from: 1930, to: 1930 });
    expect(parseYearInput('30', 2030)).toEqual({ from: 2030, to: 2030 });
  });
});

describe('what the list offers while a reader types', () => {
  /* 2025 is listed with no documents, as a platform may list every year it has. */
  const values = [
    ...[1998, 2001, 2019, 2020, 2021, 2022, 2023, 2024].map((year) => ({
      value: String(year),
      count: 1,
    })),
    { value: '2025', count: 0 },
  ];
  const offered = (text: string) => suggestPeriods(text, values, NOW).map(formatRange);
  const from2019 = ['2019–2020', '2019–2021', '2019–2022', '2019–2023', '2019–2024'];

  it.each([
    ['2', ['2024', '2023', '2022', '2021', '2020', '2019', '2001']],
    ['202', ['2024', '2023', '2022', '2021', '2020']],
    ['201', ['2019']],
    ['1', ['1998']],
    // «20» is 2020 written with two digits, and it begins the 2000s.
    ['20', ['2024', '2023', '2022', '2021', '2020', '2019', '2001']],
  ])('offers for «%s» the years with documents that begin so, newest first', (text, expected) => {
    expect(offered(text)).toEqual(expected);
  });

  it.each([
    ['2019-', from2019],
    ['2019 –', from2019],
    ['2019 t', from2019],
    ['2019 til', from2019],
    ['2019 to', from2019],
    ['2019-2', from2019],
    ['2019-20', from2019],
    ['2019-202', from2019],
    ['2019 til 202', from2019],
    ['23-2', ['2023–2024']],
    // Two digits end within a hundred years of the start: «01» is 2001.
    ['98-0', ['1998–2001']],
  ])('offers for «%s» the periods the end can become, shortest first', (text, expected) => {
    expect(offered(text)).toEqual(expected);
  });

  it.each([
    ['2023', ['2023']],
    ['2019-2022', ['2019–2022']],
    ['23-24', ['2023–2024']],
    // A whole period is offered with or without documents.
    ['2025', ['2025']],
    ['2030', ['2030']],
    ['2030-2031', ['2030–2031']],
  ])('offers «%s» as the whole period it is', (text, expected) => {
    expect(offered(text)).toEqual(expected);
  });

  it.each([[''], ['   '], ['abc'], ['3'], ['2019-1'], ['20234'], ['fra 2015'], ['-2015']])(
    'offers nothing for «%s», so the field shows the hint',
    (text) => {
      expect(offered(text)).toEqual([]);
    },
  );

  it('counts a year with no count as a year with documents, as when another field is chosen', () => {
    expect(suggestPeriods('202', [{ value: '2020' }, { value: '2023' }], NOW)).toEqual([
      { from: 2023, to: 2023 },
      { from: 2020, to: 2020 },
    ]);
  });
});

describe('a set of years, as periods', () => {
  it('gathers years in a row in one period', () => {
    expect(toRanges([2022, 2023, 2024])).toEqual([{ from: 2022, to: 2024 }]);
  });

  it('leaves a single year alone, and starts a new period after a gap', () => {
    expect(toRanges([1992, 1993, 2000, 2019, 2008, 2009, 2010])).toEqual([
      { from: 1992, to: 1993 },
      { from: 2000, to: 2000 },
      { from: 2008, to: 2010 },
      { from: 2019, to: 2019 },
    ]);
  });

  it('takes the years as strings, in any order and twice', () => {
    expect(toRanges(['2024', '2022', '2023', '2023'])).toEqual([{ from: 2022, to: 2024 }]);
  });

  it('skips what is not a whole year, and gives no periods for no years', () => {
    expect(toRanges(['2024', 'abc', '2023.5', ''])).toEqual([{ from: 2024, to: 2024 }]);
    expect(toRanges([])).toEqual([]);
  });

  it('comes back to the same years', () => {
    const years = [1992, 1993, 1994, 2000, 2008, 2009, 2020];
    expect(toRanges(years).flatMap(yearsIn)).toEqual(years);
  });
});

describe('a period’s text and key', () => {
  it('writes a single year as the year and a period with an en dash', () => {
    expect(formatRange({ from: 2019, to: 2019 })).toBe('2019');
    expect(formatRange({ from: 2022, to: 2024 })).toBe('2022–2024');
  });

  it('has a key that reads back to the same period, and reads nothing else as one', () => {
    const range = { from: 1992, to: 2000 };
    expect(rangeKey(range)).toBe('1992-2000');
    expect(rangeFromKey(rangeKey(range))).toEqual(range);
    expect(rangeFromKey('2019-2019')).toEqual({ from: 2019, to: 2019 });
    expect(rangeFromKey('2024')).toBeUndefined();
    expect(rangeFromKey('2028-2023')).toBeUndefined();
    expect(rangeFromKey('årsrapport')).toBeUndefined();
  });
});

describe('the documents in a period', () => {
  const values = [
    { value: '2024', count: 10 },
    { value: '2023', count: 5 },
    { value: '2020', count: 2 },
  ];

  it('adds up the counts from the facets, and gives 0 for years with none', () => {
    expect(documentsIn({ from: 2022, to: 2024 }, values)).toBe(15);
    expect(documentsIn({ from: 2030, to: 2031 }, values)).toBe(0);
  });

  it('gives no number when the facets have no counts, so no false 0 is shown', () => {
    expect(documentsIn({ from: 2022, to: 2024 }, [{ value: '2024' }])).toBeUndefined();
  });
});

describe('the years a period stands for', () => {
  const values = [
    { value: '2024', count: 10 },
    { value: '2020', count: 2 },
    { value: '2019', count: 0 },
    { value: '1950' },
  ];

  it('are the listed years in it with documents, not every calendar year', () => {
    expect(listedYearsIn({ from: 1800, to: 2200 }, values)).toEqual([1950, 2020, 2024]);
    expect(listedYearsIn({ from: 2021, to: 2023 }, values)).toEqual([]);
  });
});
