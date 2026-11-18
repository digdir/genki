import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../docs-props.test-utils.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const page = read('../../../../docs/components/welcome.html');

describe('the Welcome page', () => {
  it.each(['WelcomeProps', 'SuggestionsProps'])('names every field of %s', (name) => {
    expect(propsMissingFromPage(read('Welcome.tsx'), name, page)).toEqual([]);
  });

  it('lists every variable the welcome’s sheet reads', () => {
    const names = new Set(read('welcome.css').match(/--genai-[a-z]+(?:-[a-z]+)+/g));
    expect([...names].filter((name) => !page.includes(`<code>${name}</code>`))).toEqual([]);
  });
});
