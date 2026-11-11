import { describe, expect, it } from 'vitest';
import { normaliseCitationMarkers } from '@genai/port-model';
import { dropUnknownMarkers, stripSourceLists } from './citations.js';
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

  it('rewrites citation markers in linear time', () => {
    expect(quickly(() => normaliseCitationMarkers(`【0${'\t'.repeat(100_000)}x`))).toBeLessThan(
      1000,
    );
    expect(quickly(() => normaliseCitationMarkers('【1†'.repeat(30_000)))).toBeLessThan(1000);
    expect(quickly(() => normaliseCitationMarkers(`【${'1'.repeat(100_000)}`))).toBeLessThan(1000);
    expect(normaliseCitationMarkers('Svar【1†L1-L4】.')).toBe('Svar[1].');
  });

  it('removes markers that lead to no excerpt in linear time', () => {
    const index = new Map([[1, 'c1']]);
    expect(quickly(() => dropUnknownMarkers(' ['.repeat(50_000), index))).toBeLessThan(1000);
    expect(quickly(() => dropUnknownMarkers(` [${'1'.repeat(100_000)}`, index))).toBeLessThan(1000);
    expect(dropUnknownMarkers('Svar [1] og [7].', index)).toBe('Svar [1] og.');
  });

  it('strips code fences in linear time', () => {
    expect(quickly(() => stripCodeFences(`\`\`\`${'\t'.repeat(100_000)}x`))).toBeLessThan(1000);
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
});
