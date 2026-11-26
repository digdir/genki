import { describe, expect, it } from 'vitest';
import { normaliseCitationMarkers } from '@genai/port-model';
import {
  dropUnknownMarkers,
  resolveSentenceMarkers,
  sentenceIdFilter,
  stripSourceLists,
} from './citations.js';
import { sentenceUnits } from './sentences.js';
import { declineOnly, keepsTheDraft, soundsLikeRefusal } from './citation-backfill.js';
import { stripCodeFences } from './structured.js';
import { questionLanguage } from './prompts.js';
import { searchFailures } from './tools.js';
import { gapBlocks, pageMention } from './citation-gaps.js';

const quickly = (run: () => unknown) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

describe('answer cleanup on adversarial input', () => {
  it('finds the uncited blocks of an answer and the pages it names in linear time', () => {
    const index = new Map([[1, 'c1']]);
    for (const text of [
      `|${'-'.repeat(100_000)}x`,
      `${'- '.repeat(50_000)}x`,
      `**${'a'.repeat(100_000)}`,
      `${'*'.repeat(100_000)}x`,
      ` [${'1'.repeat(100_000)}`,
      '\n'.repeat(100_000),
    ])
      expect(quickly(() => gapBlocks(text, index))).toBeLessThan(1000);
    for (const text of [
      `(s. 1${' '.repeat(100_000)}`,
      '(s. 1'.repeat(30_000),
      `(side ${'9'.repeat(100_000)})`,
    ])
      expect(quickly(() => [...text.matchAll(pageMention)])).toBeLessThan(1000);
    expect(gapBlocks('## Funn\n\nSvar [1].\n\nUten kilde.\n\n|---|', index)).toHaveLength(1);
    expect([...'Organisering (s. 27–28).'.matchAll(pageMention)].map((m) => m[1])).toEqual(['27']);
  });

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

  it('compares a cited answer with its draft in linear time', () => {
    expect(
      quickly(() => keepsTheDraft(' ['.repeat(50_000), ` [${'1'.repeat(100_000)}`)),
    ).toBeLessThan(1000);
    expect(keepsTheDraft('Svar [1] og mer [2].', 'Svar og mer.')).toBe(true);
  });

  it('hears a bokmål, nynorsk or English refusal in linear time', () => {
    expect(quickly(() => soundsLikeRefusal('fann eg '.repeat(30_000)))).toBeLessThan(1000);
    expect(quickly(() => soundsLikeRefusal('kan ikkje '.repeat(30_000)))).toBeLessThan(1000);
    expect(quickly(() => soundsLikeRefusal(`har ${'ikkje '.repeat(30_000)}`))).toBeLessThan(1000);
    expect(soundsLikeRefusal('Eg fann ikkje noko om dette.')).toBe(true);
    expect(quickly(() => soundsLikeRefusal('kildene i '.repeat(30_000)))).toBeLessThan(1000);
    expect(quickly(() => soundsLikeRefusal(`kildene ${'har '.repeat(30_000)}`))).toBeLessThan(1000);
    expect(
      quickly(() => soundsLikeRefusal(`kildene har ingen ${'men '.repeat(30_000)}`)),
    ).toBeLessThan(1000);
    expect(soundsLikeRefusal('Kildene har ingen oppskrift på brunost.')).toBe(true);
  });

  it('cuts a decline to its first paragraph and offer in linear time', () => {
    expect(quickly(() => declineOnly(`a\n${' \t'.repeat(50_000)}x`))).toBeLessThan(1000);
    expect(quickly(() => declineOnly('\n'.repeat(100_000)))).toBeLessThan(1000);
    expect(declineOnly('Nei.\n\nMer.\n \nVil du?')).toBe('Nei.\n\nVil du?');
  });

  it('guesses the language of a question in linear time', () => {
    expect(quickly(() => questionLanguage('kva '.repeat(100_000)))).toBeLessThan(1000);
    expect(questionLanguage('Kva er nytt?')).toBe('nn');
  });

  it('strips code fences in linear time', () => {
    expect(quickly(() => stripCodeFences(`\`\`\`${'\t'.repeat(100_000)}x`))).toBeLessThan(1000);
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('reads which search strategy failed in linear time', () => {
    const long = (warning: string) => () => searchFailures({ warnings: [warning] });
    expect(quickly(long(`${'a-'.repeat(50_000)} search`))).toBeLessThan(1000);
    expect(quickly(long(`${'a search'.repeat(50_000)}:`))).toBeLessThan(1000);
    expect(quickly(long(`skipped ${'skipped a search'.repeat(30_000)}:`))).toBeLessThan(1000);
    expect(quickly(long(`${'a search: a'.repeat(50_000)}\n`))).toBeLessThan(1000);
    expect(quickly(long(`content search: ${' search: '.repeat(20_000)}`))).toBeLessThan(1000);
    expect(quickly(long(`content search: ${'took longer '.repeat(20_000)}`))).toBeLessThan(1000);
  });

  it('reads a sentence-id marker in linear time on a long adversarial string', () => {
    const index = new Map([[1, 'c1']]);
    const text = () => 'En. To.';
    for (const attack of [
      '[1:'.repeat(40_000),
      `[1:${'1'.repeat(100_000)}`,
      '[1:1-'.repeat(30_000),
      `[1:${', '.repeat(100_000)}`,
      `[1:${'1-'.repeat(100_000)}`,
      '⟨'.repeat(100_000),
    ])
      expect(quickly(() => resolveSentenceMarkers(attack, index, text))).toBeLessThan(1000);
    const shown: string[] = [];
    const filter = sentenceIdFilter((t) => shown.push(t));
    expect(
      quickly(() => {
        for (let i = 0; i < 20_000; i++) filter.push('[1:');
        filter.end();
      }),
    ).toBeLessThan(1000);
    expect(resolveSentenceMarkers('Svar [1:2].', index, text).text).toBe('Svar [1].');
  });

  it('splits a long excerpt into sentences in linear time', () => {
    expect(quickly(() => sentenceUnits('jf. '.repeat(30_000)))).toBeLessThan(1000);
    expect(quickly(() => sentenceUnits('| --- '.repeat(30_000)))).toBeLessThan(1000);
    expect(quickly(() => sentenceUnits('a.\n'.repeat(30_000)))).toBeLessThan(1000);
  });
});
