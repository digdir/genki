import { describe, expect, it } from 'vitest';
import { normaliseCitationMarkers, sourceListFilter, stripSourceLists } from './citations.js';

describe('source list lines', () => {
  it.each(['Kilder: [1]-[9]', '**Kilder:** [1], [2] og [3]', 'Kjelder: [2]', 'Sources: [1], [4].'])(
    'drops "%s" at the end of an answer',
    (line) => {
      expect(stripSourceLists(`Det kan jeg ikke svare på.\n\n${line}`)).toBe(
        'Det kan jeg ikke svare på.',
      );
    },
  );

  it('keeps citations in the text and lines that say more than the numbers', () => {
    const text = 'Fristen er 1. mars [1].\nKildene viser at fristen gjelder alle [2].';
    expect(stripSourceLists(text)).toBe(text);
  });

  it('holds back a streamed source list line and lets other text through', () => {
    const out: string[] = [];
    const filter = sourceListFilter((t) => out.push(t));
    for (const piece of ['Fristen ', 'er 1. mars [1].\n\nKil', 'der: [1]', '-[9]'])
      filter.push(piece);
    filter.end();
    expect(out.join('')).toBe('Fristen er 1. mars [1].\n\n');

    const kept: string[] = [];
    const other = sourceListFilter((t) => kept.push(t));
    for (const piece of ['Kildene ', 'viser [1].']) other.push(piece);
    other.end();
    expect(kept.join('')).toBe('Kildene viser [1].');
  });
});

describe('OpenAI file-search citation markers', () => {
  it.each([
    ['Lag lange passord【1†L1-L4】.', 'Lag lange passord[1].'],
    ['Se 【3†source】 og 【12:0†sikkert.no】.', 'Se [3] og [12].'],
    ['Nivået er moderat 【 2†L7 】', 'Nivået er moderat [2]'],
  ])('rewrites "%s" with the contract markers', (raw, expected) => {
    expect(normaliseCitationMarkers(raw)).toBe(expected);
  });

  it('leaves [N] and other text in corner brackets alone', () => {
    const text = 'Svar [1] og [2]. Tittelen er 【Sikker hverdag】.';
    expect(normaliseCitationMarkers(text)).toBe(text);
  });
});
