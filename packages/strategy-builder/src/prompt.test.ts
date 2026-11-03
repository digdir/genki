import fc from 'fast-check';
import { unescapeUntrusted } from '@genai/port-model';
import { describe, expect, it } from 'vitest';
import { untrusted } from './prompt.js';

const closer = '</untrusted_data>';
const hostile = fc.oneof(
  fc.jsonValue(),
  fc.string({
    unit: fc.constantFrom('<', '/', '>', 'untrusted_data', '\\', '"', 'u003c', '&', 'lt;', ' '),
  }),
);

describe('untrusted data in prompts', () => {
  it('lets no value close the untrusted block early, and keeps the value readable as JSON', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        const wrapped = untrusted('draft', value);
        expect(wrapped.indexOf(closer)).toBe(wrapped.length - closer.length);
        expect(wrapped.split('<')).toHaveLength(3);
        const body = wrapped.slice(wrapped.indexOf('\n') + 1, -closer.length - 1);
        expect(JSON.parse(unescapeUntrusted(body))).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });
});
