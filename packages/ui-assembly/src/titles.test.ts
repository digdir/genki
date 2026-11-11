import { describe, expect, it } from 'vitest';
import { shortTitle } from './useAssistant.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('a thread’s short title', () => {
  it('is the first sentence, without its stops', () => {
    expect(shortTitle('Hva er Kudos? Og hvem bruker det?')).toBe('Hva er Kudos');
    expect(shortTitle('  Hva   sier\nårsrapporten?!  ')).toBe('Hva sier årsrapporten');
    expect(shortTitle('Se kap. 3 i rapporten')).toBe('Se kap');
  });

  it('cuts a long sentence on a word at 80', () => {
    const title = shortTitle(`${'ord '.repeat(30)}slutt`);
    expect(title.endsWith(' …')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(82);
  });

  it('reads a question in linear time on long runs of stops', () => {
    expect(quickly(() => shortTitle(`${'!'.repeat(100_000)}x`))).toBeLessThan(1000);
    expect(quickly(() => shortTitle(`a${'!'.repeat(100_000)}x`))).toBeLessThan(1000);
    expect(quickly(() => shortTitle(`a${'.?'.repeat(50_000)}`))).toBeLessThan(1000);
  });
});
