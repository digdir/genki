import { describe, expect, it } from 'vitest';
import { kudosEarlierIdsMap } from './kudos-earlier-ids.js';
import { plainHeading, publicSourceUrl, sourceBreadcrumb } from './source-links.js';

const title = 'Tildelingsbrev Digitaliseringsdirektoratet 2025';
const search =
  'https://kudos.dfo.no/dokumenter?query=Tildelingsbrev%20Digitaliseringsdirektoratet%202025';
const kudos = (source: Parameters<typeof publicSourceUrl>[0]) =>
  publicSourceUrl(source, 'kudos-legacy');

const redirected = { id: '88642', uuid: '9c5070e4-d227-4228-9c3d-9dce48c625ae' };
const heldByFile = { id: '10', uuid: '2216a4b9-b486-4c41-a496-c0f8fa372488' };
const page = (uuid: string) => `https://kudos.dfo.no/dokument/${uuid}`;
const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('public source links', () => {
  it('links an old Kudos number the live site redirects to its document by UUID', () => {
    expect(kudos({ document: redirected.id, title })).toBe(page(redirected.uuid));
  });

  it('links an old Kudos number the live site does not redirect to the one document that holds its file', () => {
    expect(kudos({ document: heldByFile.id, title })).toBe(page(heldByFile.uuid));
  });

  it('links a mapped Kudos number by UUID even when the source has no title', () => {
    expect(kudos({ document: redirected.id })).toBe(page(redirected.uuid));
    expect(kudos({ url: null, document: heldByFile.id })).toBe(page(heldByFile.uuid));
  });

  it('reads the Kudos number from a digdir://doc and a kudos.dfo.no/dokument url', () => {
    expect(kudos({ url: `digdir://doc/${redirected.id}`, title })).toBe(page(redirected.uuid));
    expect(kudos({ url: `https://kudos.dfo.no/dokument/${redirected.id}`, title })).toBe(
      page(redirected.uuid),
    );
    expect(kudos({ url: `https://kudos.dfo.no/dokument/${heldByFile.id}?side=2#a`, title })).toBe(
      page(heldByFile.uuid),
    );
  });

  it('keeps the Kudos title search for a number the map cannot resolve', () => {
    for (const unresolved of ['364', '413410']) {
      expect(kudos({ document: unresolved, title })).toBe(search);
      expect(kudos({ url: `digdir://doc/${unresolved}`, title })).toBe(search);
      expect(kudos({ url: `https://kudos.dfo.no/dokument/${unresolved}`, title })).toBe(search);
    }
    expect(kudos({ document: '330297', title })).toBe(search);
  });

  it('gives no link for a number the map cannot resolve when the source has no title', () => {
    expect(kudos({ document: '364' })).toBeUndefined();
    expect(kudos({ url: 'digdir://doc/413410' })).toBeUndefined();
  });

  it('keeps a url that names its Kudos document by UUID, and any other url, as it is', () => {
    expect(
      kudos({ url: 'https://kudos.dfo.no/dokument/3f2a9c01-b7de-4a1b-9c2d-1e2f3a4b5c6d' }),
    ).toBe('https://kudos.dfo.no/dokument/3f2a9c01-b7de-4a1b-9c2d-1e2f3a4b5c6d');
    expect(kudos({ url: 'https://www.digdir.no/a' })).toBe('https://www.digdir.no/a');
    expect(kudos({ document: '3f2a9c01b7de' })).toBeUndefined();
    expect(kudos({ url: search, document: redirected.id, title })).toBe(search);
  });

  it('keeps the own url, or none, for numeric ids from a dataset without the rule', () => {
    expect(publicSourceUrl({ document: redirected.id, title })).toBeUndefined();
    expect(
      publicSourceUrl({ url: ' https://arkiv.example.no/88642 ', document: '88642', title }),
    ).toBe('https://arkiv.example.no/88642');
    expect(publicSourceUrl({ url: 'digdir://doc/88642', title })).toBe('digdir://doc/88642');
  });

  it('maps every resolved Kudos number to one well-formed UUID, in only one section', () => {
    const resolved = [
      ...Object.entries(kudosEarlierIdsMap.ids),
      ...Object.entries(kudosEarlierIdsMap.byFile ?? {}),
    ];
    const numbers = [...resolved.map(([id]) => id), ...Object.keys(kudosEarlierIdsMap.unresolved)];

    expect(resolved.length).toBeGreaterThan(0);
    expect(
      resolved.filter(([id, uuid]) => !/^\d{1,10}$/.test(id) || !uuidShape.test(uuid)),
    ).toEqual([]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('reads a source url in linear time on long input', () => {
    const quickly = (run: () => unknown) => {
      const started = performance.now();
      run();
      return performance.now() - started;
    };
    const long = [
      `digdir://doc/${'1'.repeat(100_000)}`,
      `https://kudos.dfo.no/dokument/${'1'.repeat(100_000)}x`,
      'https://kudos.dfo.no/dokument/'.repeat(100_000),
      `digdir://doc/1?${'/'.repeat(100_000)}\n`,
    ];

    for (const url of long) expect(quickly(() => kudos({ url, title }))).toBeLessThan(1000);
  });
});

describe('source headings', () => {
  it('strips inline markdown and heading markers from titles and heading paths', () => {
    expect(plainHeading('**9. Budsjettmessige forutsetninger**')).toBe(
      '9. Budsjettmessige forutsetninger',
    );
    expect(plainHeading('## **8.2.1 Rapportering')).toBe('8.2.1 Rapportering');
    expect(plainHeading('__Mål__ og *tiltak* for `2024`')).toBe('Mål og tiltak for 2024');
    expect(plainHeading('Tildelingsbrev(pdf) 2024\nmer tekst')).toBe('Tildelingsbrev(pdf) 2024');
    expect(plainHeading('C# og snake_case_navn')).toBe('C# og snake_case_navn');
  });

  it('builds a breadcrumb from plain, distinct heading levels', () => {
    expect(
      sourceBreadcrumb([
        '# **9. Budsjettmessige forutsetninger**',
        '9. Budsjettmessige forutsetninger',
        '**8.2.1 Rapportering**',
        '  ',
      ]),
    ).toBe('9. Budsjettmessige forutsetninger › 8.2.1 Rapportering');
    expect(sourceBreadcrumb([])).toBeUndefined();
  });

  it("reads Marker's markup in a heading in linear time on long input", () => {
    const quickly = (run: () => unknown) => {
      const started = performance.now();
      run();
      return performance.now() - started;
    };
    const long = [
      '<span id="page-'.repeat(100_000),
      `<span id="page-${'1'.repeat(100_000)}`,
      '[x](#page-1'.repeat(100_000),
      `${'['.repeat(100_000)}x](#page-1-0)`,
      `[${'x'.repeat(100_000)}`,
      '<sup>1'.repeat(100_000),
      `<sup>${'1'.repeat(100_000)}`,
      '<u'.repeat(100_000),
      '[[1'.repeat(100_000),
      `[\\[${'1'.repeat(100_000)}\\]](#page-`,
    ];

    for (const level of long) expect(quickly(() => sourceBreadcrumb([level]))).toBeLessThan(1000);
    expect(sourceBreadcrumb([`${'['.repeat(3)}x](#page-1-0)`])).toBe('[[x');
  });
});
