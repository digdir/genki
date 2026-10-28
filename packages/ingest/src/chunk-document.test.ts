import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunk-document.js';

const config = {
  strategy: { kind: 'header-based' as const },
  minimumLength: 200,
  maximumLength: 4000,
  metadataStyle: 'pr' as const,
};

describe('chunkDocument', () => {
  it('splits a long text without headings instead of dropping it', () => {
    const paragraph = 'Departementet ber virksomheten rapportere på måloppnåelse. '.repeat(20);
    const letter = Array.from({ length: 30 }, () => paragraph).join('\n\n');

    const chunks = chunkDocument('doc', [letter], config);

    expect(letter.length).toBeGreaterThan(config.maximumLength * 5);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.content_length <= config.maximumLength)).toBe(true);
  });
});

// Marker's text as markerConverter joins it: `{n}` and a line of 48 dashes before page n (from 0)
const dashes = '-'.repeat(48);
const markerText = (...pages: string[]) =>
  pages.map((text, n) => `\n\n{${n}}\n\n${dashes}\n\n\n\n${text}`).join('');
const byPage = {
  strategy: { kind: 'page' as const, splitMaxLength: 300 },
  minimumLength: 1,
  maximumLength: 4000,
  metadataStyle: 'pr' as const,
};

describe('chunkDocument by page', () => {
  it('gives every chunk the page Marker marked it with, counted from 1', () => {
    const chunks = chunkDocument('doc', [markerText('Første side.', 'Andre side.')], byPage);

    expect(chunks.map((c) => [c.content_markdown, c.page])).toEqual([
      ['Første side.', 1],
      ['Andre side.', 2],
    ]);
  });

  it('splits a long page by paragraph, keeping its page and each table whole', () => {
    const paragraph = 'Tildelingen til forskning økte med fem prosent fra året før. '
      .repeat(3)
      .trim();
    const table = '| År | Tildeling |\n| --- | --- |\n| 2023 | 100 |\n| 2024 | 105 |';
    const long = [paragraph, paragraph, table, paragraph].join('\n\n');

    const chunks = chunkDocument('doc', [markerText('Kort side.', long)], byPage);
    const second = chunks.filter((c) => c.page === 2);

    expect(second.length).toBe(3);
    expect(second.every((c) => c.content_length <= 300)).toBe(true);
    expect(second.some((c) => c.content_markdown.includes(table))).toBe(true);
    expect(second.map((c) => c.content_markdown).join('\n\n')).toBe(long);
  });

  it('splits a paragraph longer than the limit at sentence ends', () => {
    const sentence = 'Virksomheten skal rapportere på mål og resultater innen fristen.';
    const paragraph = Array.from({ length: 10 }, () => sentence).join(' ');

    const chunks = chunkDocument('doc', [markerText(paragraph)], byPage);

    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.content_length <= 300 && c.page === 1)).toBe(true);
    expect(chunks.every((c) => c.content_markdown.endsWith('fristen.'))).toBe(true);
    expect(chunks.map((c) => c.content_markdown).join(' ')).toBe(paragraph);
  });

  it('keeps a text without page markers, with no page number', () => {
    const chunks = chunkDocument('doc', ['Tekst fra tekstlaget.\n\nUten sidemarkører.'], byPage);

    expect(chunks.map((c) => [c.content_markdown, c.page])).toEqual([
      ['Tekst fra tekstlaget.\n\nUten sidemarkører.', undefined],
    ]);
  });

  it('leaves out a page with no text and keeps the numbers of the pages after it', () => {
    const chunks = chunkDocument('doc', [markerText('', 'Etter et bilde.')], byPage);

    expect(chunks.map((c) => [c.content_markdown, c.page])).toEqual([['Etter et bilde.', 2]]);
  });
});
