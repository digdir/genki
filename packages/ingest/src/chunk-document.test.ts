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
