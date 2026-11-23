import { readFileSync } from 'node:fs';
import { templateElements } from '@genai/contracts/block-template';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../docs-props.test-utils.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const page = read('../../../../docs/components/declarative.html');

describe('the Declarative blocks page', () => {
  it('names every prop Render takes', () => {
    expect(propsMissingFromPage(read('Render.tsx'), 'RenderProps', page)).toEqual([]);
  });

  it('names every element the language has', () => {
    expect(templateElements.filter((type) => !page.includes(`<code>${type}</code>`))).toEqual([]);
  });
});
