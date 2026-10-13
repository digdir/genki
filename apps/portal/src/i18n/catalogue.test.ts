import { catalogueProblems } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { en, nb } from '.';

describe('portal catalogue', () => {
  it('has an English text for every bokmål text', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
