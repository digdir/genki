import { describe, expect, it } from 'vitest';
import { buildEvidenceSummary } from './sufficiency.js';
import { Workspace, type Chunk } from './workspace.js';

const chunk = (n: number): Chunk => ({
  chunkId: `c${n}`,
  document: 'd1',
  position: n,
  content: `Innhold ${n}`,
});

describe('evidence summary', () => {
  it('keeps the most recently read chunks when more than eight are readable, in reading order', () => {
    const w = new Workspace({ searches: 4, reads: 6, readChars: 12000 });
    w.addChunks(Array.from({ length: 11 }, (_, i) => chunk(i)));

    const ids = buildEvidenceSummary(w, 'spørsmål')['readable-chunks'].map((c) => c['chunk-id']);

    expect(ids).toEqual(['c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']);
  });

  it('still ranks higher-scored chunks first', () => {
    const w = new Workspace({ searches: 4, reads: 6, readChars: 12000 });
    w.addChunks([...Array.from({ length: 9 }, (_, i) => chunk(i)), { ...chunk(9), score: 1 }]);

    const ids = buildEvidenceSummary(w, 'spørsmål')['readable-chunks'].map((c) => c['chunk-id']);

    expect(ids[0]).toBe('c9');
    expect(ids).toHaveLength(8);
    expect(ids).not.toContain('c0');
    expect(ids).not.toContain('c1');
  });
});
