import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../docs-props.test-utils.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const page = read('../../../../docs/components/documents.html');

describe('the Documents page', () => {
  it.each([
    ['Documents.tsx', 'DocumentItem'],
    ['Documents.tsx', 'DocumentsProps'],
    ['Documents.tsx', 'OwnDocument'],
    ['Documents.tsx', 'OwnDocumentsProps'],
    ['InScope.tsx', 'DocumentInScope'],
    ['InScope.tsx', 'DocumentsInScopeProps'],
  ])('names every field of %s’s %s', (file, name) => {
    expect(propsMissingFromPage(read(file), name, page)).toEqual([]);
  });

  it('lists every variable the documents sheet reads', () => {
    const names = new Set(read('documents.css').match(/--genai-[a-z]+(?:-[a-z]+)+/g));
    expect(names.size).toBeGreaterThan(30);
    expect([...names].filter((name) => !page.includes(`<code>${name}</code>`))).toEqual([]);
  });
});
