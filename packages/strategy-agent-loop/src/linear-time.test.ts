import { describe, expect, it } from 'vitest';
import { stripSourceLists } from './citations.js';
import { stripCodeFences } from './structured.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('answer cleanup on adversarial input', () => {
  it('recognises a source list line in linear time', () => {
    expect(quickly(() => stripSourceLists(`kilde ${'\t[0]'.repeat(30_000)}x`))).toBeLessThan(1000);
    expect(stripSourceLists('Svar.\n**Kilder:** [1], [2]')).toBe('Svar.');
  });

  it('strips code fences in linear time', () => {
    expect(quickly(() => stripCodeFences(`\`\`\`${'\t'.repeat(100_000)}x`))).toBeLessThan(1000);
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
});
