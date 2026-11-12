import { describe, expect, it } from 'vitest';
import {
  bestContentWindow,
  bestContentWindows,
  containsWord,
  contentSnippet,
  formatMetadataHeaders,
  numbersIn,
  queryYearsIn,
  tokenize,
  truncateHeadTail,
  yearsIn,
} from './text.js';

describe('content snippets (ported from rerank_test)', () => {
  it('is empty for missing content', () => {
    expect(contentSnippet(undefined, 'filstørrelse')).toBe('');
    expect(contentSnippet('', 'filstørrelse')).toBe('');
  });

  it('returns short content whole with whitespace collapsed', () => {
    expect(contentSnippet('Maks   filstørrelse\n\ner 250 MB.', 'filstørrelse', 220)).toBe(
      'Maks filstørrelse er 250 MB.',
    );
  });

  it('stays within the budget on one line', () => {
    const snip = contentSnippet(Array(400).fill('lorem ipsum dolor').join(' '), 'lorem', 120);
    expect(snip.length).toBeLessThanOrEqual(120);
    expect(snip).not.toContain('\n');
    expect(snip.length).toBeGreaterThan(0);
  });

  it('windows to the passage with the query terms', () => {
    const filler = Array(200).fill('alpha beta gamma').join(' ');
    const snip = contentSnippet(
      `${filler} VIRUSSKANN skjer automatisk ved opplasting. ${filler}`,
      'virusskann opplasting',
      120,
    );
    expect(snip.toLowerCase()).toContain('virusskann');
  });
});

describe('rerank passage windows', () => {
  it('returns content unchanged when it fits, and the head when no query term matches', () => {
    expect(bestContentWindow('kort tekst', 'tekst', 100)).toBe('kort tekst');
    expect(bestContentWindow('a'.repeat(50), 'ingenting', 20)).toBe('a'.repeat(20));
  });

  it('picks the earliest window with the most distinct query terms', () => {
    const content = `${'x '.repeat(30)}budsjett tildeling ${'y '.repeat(30)}`;
    expect(bestContentWindow(content, 'budsjett tildeling', 30)).toContain('budsjett tildeling');
  });

  it('joins two distant passages when the second adds query terms, and falls back otherwise', () => {
    const content = `budsjett ${'a '.repeat(100)}tildeling ${'b '.repeat(100)}`;
    const two = bestContentWindows(content, 'budsjett tildeling', 40);
    expect(two).toContain('\n...\n');
    expect(two.startsWith('budsjett')).toBe(true);
    expect(two).toContain('tildeling');

    const onlyOne = `budsjett ${'a '.repeat(100)}`;
    expect(bestContentWindows(onlyOne, 'budsjett', 40)).toBe(
      bestContentWindow(onlyOne, 'budsjett', 40),
    );
  });

  it('truncates head and tail around a marker', () => {
    expect(truncateHeadTail('abcdefghijklmnopqrst', 15)).toBe('abcde\n...\npqrst');
    expect(truncateHeadTail('abcdefghij', 5)).toBe('abcde');
    expect(truncateHeadTail('short', 50)).toBe('short');
  });
});

describe('metadata headers', () => {
  it('formats Header N entries from an EDN map, sorted by level and capped at four hashes', () => {
    expect(
      formatMetadataHeaders(
        '{"Header 2" "Del 1", "Header 1" "Årsrapport 2022", "Header 3" "Ansatte", "source" "x"}',
      ),
    ).toBe('### Årsrapport 2022\n#### Del 1\n#### Ansatte');
  });

  it('reads double-encoded EDN and keyword keys, and gives nothing for non-maps', () => {
    expect(formatMetadataHeaders(JSON.stringify('{"Header 1" "Tittel"}'))).toBe('### Tittel');
    expect(formatMetadataHeaders('{:Header 1}')).toBeUndefined();
    expect(formatMetadataHeaders('not edn {')).toBeUndefined();
    expect(formatMetadataHeaders(undefined)).toBeUndefined();
  });
});

describe('Java regex semantics', () => {
  it('treats Norwegian letters as word characters at a boundary, like Java', () => {
    expect(yearsIn('rapport 2022, ikke 2022å eller x2023')).toEqual(new Set(['2022']));
    expect(numbersIn('Digdir hadde 326 årsverk i 2022.')).toEqual(['326 ', '2022']);
  });

  it('tokenises on anything that is not a letter or number', () => {
    expect(tokenize('Hvor mange årsverk? 2022/23')).toEqual(
      new Set(['hvor', 'mange', 'årsverk', '2022', '23']),
    );
  });
});

describe('naming an organisation in a query', () => {
  it('matches a facet value whatever its case', () => {
    expect(containsWord('Hva gjør DIGDIR i 2024?', 'Digdir')).toBe(true);
  });

  it('matches a facet value only as a whole word', () => {
    expect(containsWord('Hva gjør digdirsk folk?', 'Digdir')).toBe(false);
  });

  it('lower-case æøå match their capitals', () => {
    expect(containsWord('hva sier dfø', 'DFØ')).toBe(true);
    expect(containsWord('Spør økokrim', 'ØKOKRIM')).toBe(true);
    expect(containsWord('Åpenhet i ålesund kommune', 'Ålesund kommune')).toBe(true);
  });

  it('a genitive organisation name is detected', () => {
    expect(containsWord('Datatilsynets arbeid', 'Datatilsynet')).toBe(true);
    expect(containsWord('ifølge DFØs evaluering', 'DFØ')).toBe(true);
    expect(containsWord('ifølge DFØss evaluering', 'DFØ')).toBe(false);
  });

  it('matches in linear time on a long run of near misses', () => {
    const started = performance.now();
    containsWord('a'.repeat(100_000), `${'a'.repeat(50)}b`);
    containsWord('as'.repeat(50_000), 'a');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('reading a year from a query', () => {
  it('a number standing alone or after a word like i, fra or til is a year', () => {
    expect(queryYearsIn('Årsrapport 2022')).toEqual(new Set(['2022']));
    expect(queryYearsIn('tall fra 2019 til 2021')).toEqual(new Set(['2019', '2021']));
  });

  it('an amount is not read as a year', () => {
    expect(queryYearsIn('Kostnad på 2000 kroner i 2023')).toEqual(new Set(['2023']));
    expect(queryYearsIn('2000 kr, kr 2100, 2050 NOK, 2020 % og 2000 ansatte')).toEqual(new Set());
  });

  it('the word nok before a year does not make it an amount', () => {
    expect(queryYearsIn('Er det nok 2024?')).toEqual(new Set(['2024']));
  });

  it('reads years in linear time on a long run of numbers and spaces', () => {
    const started = performance.now();
    queryYearsIn('2023 '.repeat(20_000));
    queryYearsIn(`kr${' '.repeat(100_000)}2023`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
