import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../sources/fixtures/docsProps.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');

describe('the Footnotes page', () => {
  it('names every prop the answer block takes', () => {
    expect(
      propsMissingFromPage(
        read('Answer.tsx'),
        'AnswerProps',
        read('../../../../docs/components/footnotes.html'),
      ),
    ).toEqual([]);
  });
});
