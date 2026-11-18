import { describe, expect, it } from 'vitest';
import { translator } from '../../i18n';
import { draftOf, recordOf } from './ProcessorRecord';

const t = translator('en');

describe('the processor record form', () => {
  it('a processor record needs an agreement and whole retention days; empty sub-processor rows are left out', () => {
    expect(recordOf(draftOf(null), t)).toEqual({
      errors: {
        agreement: 'Enter which agreement applies.',
        'retention.days': 'Enter a whole number from 0 to 3650.',
      },
    });
    expect(
      recordOf(
        {
          agreement: ' DPA-2026-17 ',
          subProcessors: [
            { name: 'Lab Cloud AS', location: 'Norway' },
            { name: '', location: '' },
          ],
          days: '30',
          note: '',
        },
        t,
      ),
    ).toEqual({
      record: {
        agreement: 'DPA-2026-17',
        subProcessors: [{ name: 'Lab Cloud AS', location: 'Norway' }],
        retention: { days: 30 },
      },
    });
    expect(
      recordOf(
        { agreement: 'x', subProcessors: [{ name: 'Lab', location: '' }], days: '1.5', note: '' },
        t,
      ),
    ).toEqual({
      errors: {
        'subProcessors.0.location': 'Enter where the data is processed.',
        'retention.days': 'Enter a whole number from 0 to 3650.',
      },
    });
  });
});
