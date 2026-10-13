import { describe, expect, it } from 'vitest';
import {
  bestContentWindow,
  bestContentWindows,
  containsWord,
  contentSnippet,
  formatMetadataHeaders,
  numbersIn,
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

  it('matches facet values case-insensitively for ASCII only, on word boundaries', () => {
    expect(containsWord('Hva gjør DIGDIR i 2024?', 'Digdir')).toBe(true);
    expect(containsWord('Hva gjør digdirs folk?', 'Digdir')).toBe(false);
    expect(containsWord('Spør økokrim', 'Økokrim')).toBe(false);
    expect(containsWord('Spør Økokrim', 'Økokrim')).toBe(true);
  });

  it('tokenises on anything that is not a letter or number', () => {
    expect(tokenize('Hvor mange årsverk? 2022/23')).toEqual(
      new Set(['hvor', 'mange', 'årsverk', '2022', '23']),
    );
  });
});
