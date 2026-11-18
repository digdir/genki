import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { href, parseHash, type Route } from './router';

const pages: Route['page'][] = [
  'oversikt',
  'malbilde',
  'byggeklosser',
  'tjenester',
  'sok',
  'typer',
  'status',
  'kom-i-gang',
  'ikke-funnet',
];
const slug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/);
const text = fc.string({ unit: 'grapheme', minLength: 1 });
const route: fc.Arbitrary<Route> = fc.oneof(
  fc.constantFrom<Route>({ page: 'oversikt' }, { page: 'malbilde' }, { page: 'kom-i-gang' }),
  fc.constant<Route>({ page: 'byggeklosser' }),
  fc.record({
    page: fc.constant('byggeklosser' as const),
    id: slug,
    sub: fc.option(slug, { nil: undefined }),
  }),
  fc.constant<Route>({ page: 'tjenester' }),
  fc.record({
    page: fc.constant('tjenester' as const),
    id: slug,
    del: fc.constantFrom('bruk' as const, 'oppsett' as const, undefined),
    steg: fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
  }),
  fc.record({ page: fc.constant('typer' as const), id: fc.option(slug, { nil: undefined }) }),
  fc.record({ page: fc.constant('status' as const), id: fc.option(text, { nil: undefined }) }),
  fc.record({ page: fc.constant('sok' as const), q: fc.option(text, { nil: undefined }) }),
);

const hash = fc.oneof(
  fc.string({ unit: 'binary' }),
  fc.string({ unit: fc.constantFrom('#', '/', '?', '%', '&', '=', 'a', 'E', '0', '\uD800') }),
  fc.constantFrom('tjenester', 'byggeklosser', 'status', 'sok', 'flyt').chain((page) =>
    fc
      .string({
        unit: fc.constantFrom('/', '?', '%', '&', '=', 'a', 'E', '0', 'q', 'del', 'steg'),
      })
      .map((rest) => `#/${page}${rest}`),
  ),
);

describe('docs site routing on arbitrary addresses', () => {
  it('turns any hash into a known page without throwing', () => {
    fc.assert(
      fc.property(hash, (value) => {
        expect(pages).toContain(parseHash(value).page);
      }),
    );
  });

  it('reads back every route it writes', () => {
    fc.assert(
      fc.property(route, (value) => {
        expect(parseHash(href(value))).toEqual(value);
      }),
    );
  });
});
