import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../fixtures/docsProps.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const page = read('../../../../docs/components/approach.html');

describe('the Approach page', () => {
  it('names every prop the block takes', () => {
    expect(propsMissingFromPage(read('Approach.tsx'), 'ApproachProps', page)).toEqual([]);
  });

  it('names every field of a step', () => {
    expect(propsMissingFromPage(read('Approach.tsx'), 'ApproachStep', page)).toEqual([]);
  });
});
