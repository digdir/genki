import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { propsMissingFromPage } from '../sources/fixtures/docsProps.js';

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, 'utf8');

describe('the Conversation page', () => {
  it('names every prop the block takes', () => {
    expect(
      propsMissingFromPage(
        read('Conversation.tsx'),
        'ConversationProps',
        read('../../../../docs/components/conversation.html'),
      ),
    ).toEqual([]);
  });
});
