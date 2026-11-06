import { describe, expect, it } from 'vitest';
import { translator } from './i18n';
import { operationName, rebind } from './model-operations';

describe('API bindings on a model', () => {
  it('binding one kind keeps the API bound for every other kind', () => {
    const bound = { chat: 'openai/chat-completions@1', decide: 'openai/decide@1' };
    expect(rebind(bound, 'chat', 'openai/responses@1')).toEqual({
      chat: 'openai/responses@1',
      decide: 'openai/decide@1',
    });
    expect(rebind(bound, 'decide', '')).toEqual({ chat: 'openai/chat-completions@1' });
  });

  it('labels built-in and well-known kinds in the language and shows other kinds by name', () => {
    expect(operationName('decide', translator('nb'))).toBe('Avgjørelser');
    expect(operationName('decide', translator('en'))).toBe('Decisions');
    expect(operationName('generate-image', translator('nb'))).toBe('Bildegenerering');
    expect(operationName('generate-image', translator('en'))).toBe('Image generation');
    expect(operationName('summarize-table', translator('en'))).toBe('summarize-table');
    expect(operationName('toString', translator('en'))).toBe('toString');
  });
});
