import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../docs-props.test-utils.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');
const page = () => read('../../../../docs/components/chat.html');

describe('the Chat page', () => {
  it.each([
    ['Composer.tsx', 'ComposerProps'],
    ['types.ts', 'ComposerAttachments'],
    ['types.ts', 'ComposerAttachment'],
    ['../welcome/Welcome.tsx', 'WelcomeProps'],
    ['../welcome/Welcome.tsx', 'SuggestionsProps'],
  ])('names every field of %s’s %s', (file, name) => {
    expect(propsMissingFromPage(read(file), name, page())).toEqual([]);
  });
});
