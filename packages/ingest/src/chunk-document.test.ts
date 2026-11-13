import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunk-document.js';
import { joinPages } from './converter.js';

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

describe('chunkDocument by page', () => {
  const byPage = (splitMaxLength: number) => ({
    strategy: { kind: 'page' as const, splitMaxLength },
    minimumLength: 1,
    maximumLength: 4000,
    metadataStyle: 'pr' as const,
  });
  const texts = (chunks: { content_markdown: string }[]) => chunks.map((c) => c.content_markdown);

  it('never puts two pages in one chunk', () => {
    const chunks = chunkDocument(
      'doc',
      [joinPages(['Side én.', 'Side to.', 'Side tre.'])],
      byPage(4000),
    );

    expect(texts(chunks)).toEqual(['Side én.', 'Side to.', 'Side tre.']);
  });

  it('splits a page longer than the limit at paragraphs, then sentences, then words', () => {
    const page = [
      'Første avsnitt er kort.',
      'Andre avsnitt har to setninger. Den andre setningen er lang nok til å deles.',
      'ord '.repeat(30).trim(),
    ].join('\n\n');

    const chunks = chunkDocument('doc', [joinPages([page])], byPage(60));

    expect(texts(chunks)).toEqual([
      'Første avsnitt er kort.\n\nAndre avsnitt har to setninger.',
      'Den andre setningen er lang nok til å deles.',
      'ord '.repeat(15).trim(),
      'ord '.repeat(15).trim(),
    ]);
    for (const chunk of chunks) expect(chunk.content_markdown.length).toBeLessThanOrEqual(60);
  });

  it('keeps a Markdown table whole when it fits', () => {
    const table = '| Post | Beløp |\n| --- | --- |\n| Lønn | 1 200 |\n| Drift | 300 |';
    const chunks = chunkDocument(
      'doc',
      [joinPages([`Innledning til tabellen.\n\n${table}`])],
      byPage(70),
    );

    expect(texts(chunks)).toContain(table);
  });

  it('an empty page gives no chunk', () => {
    const chunks = chunkDocument(
      'doc',
      [joinPages(['Side én.', '', '   ', 'Side fire.'])],
      byPage(4000),
    );

    expect(texts(chunks)).toEqual(['Side én.', 'Side fire.']);
  });
});
