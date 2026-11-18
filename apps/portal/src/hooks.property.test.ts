import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRoute } from './hooks';

const hash = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.string({ unit: fc.constantFrom('#', '/', '?', '%', '&', '=', 'a', 'E', '0', '\uD800') }),
);

describe('portal routing on arbitrary addresses', () => {
  it('turns any hash, even one with a malformed escape, into a route without throwing', () => {
    fc.assert(
      fc.property(hash, (value) => {
        const route = parseRoute(value);
        expect(route.path).toBe(`/${route.segments.join('/')}`);
      }),
    );
  });

  it('reads back any path segments it is given encoded', () => {
    const segment = fc.string({ unit: 'grapheme', minLength: 1 });
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 4 }), (segments) => {
        const hash = `#/${segments.map(encodeURIComponent).join('/')}`;
        expect(parseRoute(hash).segments).toEqual(segments);
      }),
    );
  });
});
