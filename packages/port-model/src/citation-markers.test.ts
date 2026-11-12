import { describe, expect, it } from 'vitest';
import { normaliseCitationMarkers } from './citation-markers.js';

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
