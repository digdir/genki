import { describe, expect, it } from 'vitest';
import { translator } from './i18n';
import { exampleOperationKinds } from './mock';
import {
  offeredOperations,
  operationChoices,
  operationName,
  toggleOperation,
} from './model-operations';

describe('operation kinds in the model form', () => {
  it('a model without operations offers chat only, as the API says', () => {
    expect(offeredOperations({})).toEqual(['chat']);
    expect(offeredOperations({ operations: ['generate-image'] })).toEqual(['generate-image']);
  });

  it('lists every operation kind the platform knows, built-in kinds first', () => {
    expect(operationChoices(exampleOperationKinds, ['chat']).map((c) => c.kind)).toEqual([
      'chat',
      'decide',
      'generate-image',
    ]);
  });

  it('a kind the model offers is listed even when the kinds list is missing or lacks it', () => {
    expect(operationChoices(undefined, ['chat', 'transcribe-audio']).map((c) => c.kind)).toEqual([
      'chat',
      'decide',
      'transcribe-audio',
    ]);
    expect(
      operationChoices(exampleOperationKinds, ['summarize-table']).map((c) => c.kind),
    ).toContain('summarize-table');
  });

  it('marks the maturity of descriptor kinds only, never of built-in kinds', () => {
    const choices = operationChoices(exampleOperationKinds, []);
    expect(choices.find((c) => c.kind === 'chat')?.maturity).toBeUndefined();
    expect(choices.find((c) => c.kind === 'generate-image')?.maturity).toBe('test');
  });

  it('a kind the model offers is kept when another kind is ticked or cleared', () => {
    expect(toggleOperation(['generate-image'], 'chat', true)).toEqual(['generate-image', 'chat']);
    expect(toggleOperation(['generate-image', 'chat'], 'chat', false)).toEqual(['generate-image']);
    expect(toggleOperation(['chat'], 'chat', true)).toEqual(['chat']);
  });

  it('labels built-in kinds in the language and shows other kinds by name', () => {
    expect(operationName('decide', translator('nb'))).toBe('Avgjørelser');
    expect(operationName('decide', translator('en'))).toBe('Decisions');
    expect(operationName('generate-image', translator('en'))).toBe('generate-image');
  });
});
