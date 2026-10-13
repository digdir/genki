import { catalogueProblems } from '@genai/i18n';
import { describe, expect, it } from 'vitest';
import { en, nb } from './index';

describe('console catalogues', () => {
  it('has a complete English catalogue', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
