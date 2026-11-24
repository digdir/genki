import { describe, expect, it } from 'vitest';
import { sourceListFilter, stripSourceLists } from './citations.js';

describe('source list lines', () => {
  it.each(['Kilder: [1]-[9]', '**Kilder:** [1], [2] og [3]', 'Kjelder: [2]', 'Sources: [1], [4].'])(
    'drops "%s" at the end of an answer',
    (line) => {
      expect(stripSourceLists(`Det kan jeg ikke svare på.\n\n${line}`)).toBe(
        'Det kan jeg ikke svare på.',
      );
    },
  );

  it.each([
    'Kilder: [1] s. 4',
    'Kilder: [1] s. 4–5, [2] s. 9',
    '**Kilder:** [1] s. 4 og [2] s. 7',
    'Kilder: [1] s. 5, 34 og 42',
    'Kilder: [1] s. 61 – 62 og [2] s. 3',
    'Kilder: [1, s. 5, 34 og 42], [2, s. 61 – 62]',
  ])('drops a source list line with pages, "%s", at the end of an answer', (line) => {
    expect(stripSourceLists(`Det kan jeg ikke svare på.\n\n${line}`)).toBe(
      'Det kan jeg ikke svare på.',
    );
  });

  it('recognises a source list line with pages in linear time', () => {
    const started = performance.now();
    stripSourceLists(`kilder: ${'[1, s. 1] s. 1–2 og '.repeat(20_000)}x`);
    stripSourceLists(`kilder: ${'[1 s. 1'.repeat(30_000)}`);
    stripSourceLists(`kilder: [1] s. 1${', 1 og 1 – 1'.repeat(20_000)}x`);
    stripSourceLists(`kilder: ${'[1, s. 1, 1 og 1] s. 1 og '.repeat(10_000)}[`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(stripSourceLists('Svar.\nKilder: [1, s. 4], [2, s. 9]')).toBe('Svar.');
  });

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
