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

describe('a page written inside the citation bracket', () => {
  const sources = (n: number) => n >= 1 && n <= 3;

  it.each([
    ['digitale tilbud [1, s. 63].', 'digitale tilbud [1] s. 63.'],
    ['uansett form. [1 s. 61]', 'uansett form. [1] s. 61'],
  ])('reads "%s" as citation [1] with the page as plain text', (raw, expected) => {
    expect(normaliseCitationMarkers(raw, sources)).toBe(expected);
  });

  // Each form agent-loop answers in test wrote between 2026-11-19 and 2026-11-24.
  it.each([
    ['Tiltaket virket [1, s. 9–10].', 'Tiltaket virket [1] s. 9–10.'],
    ['Det står flere steder [1, s. 175 og 177].', 'Det står flere steder [1] s. 175 og 177.'],
    ['Begge peker på det [2, s. 77; 3, s. 8].', 'Begge peker på det [2] s. 77; [3] s. 8.'],
    ['Se [1, s. 5, 34, 42].', 'Se [1] s. 5, 34, 42.'],
    ['Se [1, s. 4–5 og 14].', 'Se [1] s. 4–5 og 14.'],
    ['Se [1, s. 104, 175 og 177].', 'Se [1] s. 104, 175 og 177.'],
    ['Se [1, s. 7; 1, s. 46–47].', 'Se [1] s. 7; [1] s. 46–47.'],
  ])('reads "%s" with each source cited and its pages as plain text', (raw, expected) => {
    expect(normaliseCitationMarkers(raw, sources)).toBe(expected);
  });

  it('leaves [N, M] without a page as it is', () => {
    const text = 'Begge sier det [1, 2].';
    expect(normaliseCitationMarkers(text, sources)).toBe(text);
  });

  it('leaves a bracket whose number is not a source as it is', () => {
    const text = 'Se tabellen [7, s. 12] og [2023, s. 4].';
    expect(normaliseCitationMarkers(text, sources)).toBe(text);
  });

  it('leaves a bracket that holds more than a source and a page as it is', () => {
    const text = 'Se [1, s. 4 og videre] og [1, kapittel 2] og [s. 4].';
    expect(normaliseCitationMarkers(text, sources)).toBe(text);
  });

  it('rewrites citation markers in linear time on adversarial input', () => {
    const quickly = (run: () => unknown) => {
      const started = performance.now();
      run();
      return performance.now() - started;
    };
    expect(
      quickly(() => normaliseCitationMarkers('[1, s. 1'.repeat(30_000), sources)),
    ).toBeLessThan(1000);
    expect(
      quickly(() => normaliseCitationMarkers(`[${'1 '.repeat(100_000)}]`, sources)),
    ).toBeLessThan(1000);
    expect(quickly(() => normaliseCitationMarkers('['.repeat(100_000), sources))).toBeLessThan(
      1000,
    );
    expect(
      quickly(() => normaliseCitationMarkers(`[1, s.${' '.repeat(100_000)}1]`, sources)),
    ).toBeLessThan(1000);
    expect(
      quickly(() => normaliseCitationMarkers(`[1, s. 1${', 1 og 1–'.repeat(30_000)}]`, sources)),
    ).toBeLessThan(1000);
    expect(normaliseCitationMarkers('Svar [1, s. 63].', sources)).toBe('Svar [1] s. 63.');
  });
});
