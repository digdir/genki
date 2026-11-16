import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../docs-props.test-utils.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const page = read('../../../../docs/components/corpus.html');

describe('the Corpus choice page', () => {
  it.each(['CorpusOption', 'CorpusLineProps', 'CorpusChoiceProps'])(
    'names every field of %s',
    (name) => {
      expect(propsMissingFromPage(read('Corpus.tsx'), name, page)).toEqual([]);
    },
  );

  it('lists every variable the corpus sheet reads', () => {
    const names = new Set(read('corpus.css').match(/--genai-[a-z]+(?:-[a-z]+)+/g));
    expect([...names].filter((name) => !page.includes(`<code>${name}</code>`))).toEqual([]);
  });
});
