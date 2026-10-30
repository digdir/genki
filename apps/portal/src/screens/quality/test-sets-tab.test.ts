import { describe, expect, it } from 'vitest';
import type { TestSet } from '../../types';
import { casesFrom } from './TestSetsTab';

const setWith = (expected: TestSet['spec']['cases'][number]['expected']): TestSet => ({
  metadata: { tenant: '991825827', id: 'kudos', name: 'Kudos', version: 1 },
  spec: {
    cases: [
      {
        id: 'egen-sak',
        split: 'validation',
        input: 'Hvem eier Kudos?',
        tags: [],
        needsReview: false,
        expected,
      },
    ],
  },
});

describe('the test sets tab', () => {
  it('shows a criteria case by its criteria, and by its reference answer when it has none', () => {
    const both = setWith({
      referenceAnswer: 'DFØ eier Kudos.',
      criteria: { criteria: 'Nevner DFØ' },
    });
    const reference = setWith({ referenceAnswer: 'DFØ eier Kudos.' });

    expect(casesFrom([both], true)[0]?.crit).toBe('Nevner DFØ');
    expect(casesFrom([reference], true)[0]?.crit).toBe('DFØ eier Kudos.');
  });
});
