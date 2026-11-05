import { describe, expect, it } from 'vitest';
import { translator } from './i18n';
import { exampleApis, exampleOperationKinds } from './mock';
import { kindChoices, offeredOperations, operationName, rebind } from './model-operations';

const choices = (bound: Record<string, string>, families?: string[]) =>
  kindChoices(exampleOperationKinds, exampleApis, bound, families).map((c) => [c.kind, c.apis]);

describe('API bindings in the model table', () => {
  it('a model without operations offers chat only, as the API says', () => {
    expect(offeredOperations({})).toEqual(['chat']);
    expect(offeredOperations({ operations: ['generate-image'] })).toEqual(['generate-image']);
    expect(offeredOperations({ apis: { decide: 'openai/decide@1' } })).toEqual(['decide']);
  });

  it('a model is offered an API only when its connection offers the API family', () => {
    expect(choices({ chat: 'openai/chat-completions@1' }, ['openai'])).toEqual([
      ['chat', ['openai/chat-completions@1', 'openai/responses@1']],
      ['decide', ['openai/decide@1']],
      ['generate-image', ['openai/generate-image@1']],
    ]);
    expect(choices({ chat: 'anthropic/messages@1' }, ['anthropic'])).toEqual([
      ['chat', ['anthropic/messages@1']],
    ]);
  });

  it('a connection with two families offers the APIs of both', () => {
    expect(choices({}, ['openai', 'anthropic'])[0]).toEqual([
      'chat',
      ['anthropic/messages@1', 'openai/chat-completions@1', 'openai/responses@1'],
    ]);
  });

  it('a bound API is listed even when the API list is missing or lacks it', () => {
    expect(
      kindChoices(undefined, undefined, { 'transcribe-audio': 'acme/transcribe@1' }, ['acme']),
    ).toEqual([
      { kind: 'transcribe-audio', apis: ['acme/transcribe@1'], bound: 'acme/transcribe@1' },
    ]);
  });

  it('marks the maturity of descriptor kinds only, never of built-in kinds', () => {
    const all = kindChoices(exampleOperationKinds, exampleApis, {}, ['openai']);
    expect(all.find((c) => c.kind === 'chat')?.maturity).toBeUndefined();
    expect(all.find((c) => c.kind === 'generate-image')?.maturity).toBe('test');
  });

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
