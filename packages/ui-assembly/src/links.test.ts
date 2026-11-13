import { describe, expect, it } from 'vitest';
import { documentLink } from './links.js';
import type { CorpusProfile } from './profile.js';

// A collection whose documents are numbered two ways, as Kudos's are.
const kudos: CorpusProfile = {
  documentLinks: {
    digits: 'https://kudos.dfo.no/documents/{id}',
    uuid: 'https://kudos.dfo.no/dokument/{id}',
  },
};
const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('a document’s link from its number', () => {
  it('takes the template the number fits: digits, then a UUID', () => {
    expect(documentLink(kudos, '1234')).toBe('https://kudos.dfo.no/documents/1234');
    expect(documentLink(kudos, uuid)).toBe(`https://kudos.dfo.no/dokument/${uuid}`);
    expect(documentLink(kudos, uuid.toUpperCase())).toBe(
      `https://kudos.dfo.no/dokument/${uuid.toUpperCase()}`,
    );
  });

  it('gives no link to a number no template fits', () => {
    expect(documentLink(kudos, 'd20')).toBeUndefined();
    expect(documentLink(kudos, '12a')).toBeUndefined();
    expect(documentLink({}, '1234')).toBeUndefined();
    expect(documentLink(undefined, '1234')).toBeUndefined();
  });

  it('takes `any` for every number the others do not fit, with the number encoded', () => {
    const any = { documentLinks: { ...kudos.documentLinks, any: 'https://example.org/d?id={id}' } };
    expect(documentLink(any, 'a/b c')).toBe('https://example.org/d?id=a%2Fb%20c');
    expect(documentLink(any, '1234')).toBe('https://kudos.dfo.no/documents/1234');
  });

  it('makes a link only of an http or https address', () => {
    const bad = (template: string) => documentLink({ documentLinks: { any: template } }, '1');
    expect(bad('javascript:alert({id})')).toBeUndefined();
    expect(bad('data:text/html,{id}')).toBeUndefined();
    expect(bad('/documents/{id}')).toBeUndefined();
    expect(bad('http://example.org/{id}')).toBe('http://example.org/1');
  });

  it('keeps the host’s function first, and takes the templates where it gives no link', () => {
    const both: CorpusProfile = {
      ...kudos,
      documentUrl: (id) => (id === '1' ? 'https://host.example/1' : undefined),
    };
    expect(documentLink(both, '1')).toBe('https://host.example/1');
    expect(documentLink(both, '2')).toBe('https://kudos.dfo.no/documents/2');
  });

  it('reads a long number in linear time', () => {
    const long = `${'1'.repeat(200_000)}-`;
    const started = performance.now();
    expect(documentLink(kudos, long)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
  });
});
