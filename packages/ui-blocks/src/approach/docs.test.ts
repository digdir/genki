import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../docs-props.test-utils.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const page = read('../../../../docs/components/approach.html');
const props = page.slice(page.indexOf('<h2>Props</h2>'), page.indexOf('<h2>Related</h2>'));
const code = read('Approach.tsx');

describe('the Approach page', () => {
  it('lists the props in a section of their own', () => {
    expect(props.length).toBeGreaterThan(100);
  });

  it('names every prop the block takes', () => {
    expect(propsMissingFromPage(code, 'ApproachProps', props)).toEqual([]);
  });

  it('names every field of a step', () => {
    expect(propsMissingFromPage(code, 'ApproachStep', props)).toEqual([]);
  });

  it('names every field of a document a step read', () => {
    expect(propsMissingFromPage(code, 'ApproachDocument', props)).toEqual([]);
  });
});
