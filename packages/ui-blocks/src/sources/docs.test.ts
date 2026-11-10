import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from './fixtures/docsProps.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');

describe('the Sources page', () => {
  it('names every prop the block takes', () => {
    expect(
      propsMissingFromPage(
        read('Sources.tsx'),
        'SourcesProps',
        read('../../../../docs/components/sources.html'),
      ),
    ).toEqual([]);
  });
});
