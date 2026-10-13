import { describe, expect, it } from 'vitest';
import { plainHeading, publicSourceUrl, sourceBreadcrumb } from './source-links.js';

const title = 'Tildelingsbrev Digitaliseringsdirektoratet 2025';
const search =
  'https://kudos.dfo.no/dokumenter?query=Tildelingsbrev%20Digitaliseringsdirektoratet%202025';

describe('public source links', () => {
  it('links retired numeric ids from a kudos-legacy dataset to a Kudos search for the title', () => {
    const kudos = (source: Parameters<typeof publicSourceUrl>[0]) =>
      publicSourceUrl(source, 'kudos-legacy');

    expect(kudos({ url: 'digdir://doc/330296', title })).toBe(search);
    expect(kudos({ url: 'https://kudos.dfo.no/dokument/330296', title })).toBe(search);
    expect(kudos({ document: '330296', title })).toBe(search);
    expect(kudos({ url: null, document: '330296', title })).toBe(search);
    expect(kudos({ document: '330296' })).toBeUndefined();
    expect(
      kudos({ url: 'https://kudos.dfo.no/dokument/3f2a9c01-b7de-4a1b-9c2d-1e2f3a4b5c6d' }),
    ).toBe('https://kudos.dfo.no/dokument/3f2a9c01-b7de-4a1b-9c2d-1e2f3a4b5c6d');
    expect(kudos({ url: 'https://www.digdir.no/a' })).toBe('https://www.digdir.no/a');
    expect(kudos({ document: '3f2a9c01b7de' })).toBeUndefined();
    expect(kudos({ url: search, document: '330296', title })).toBe(search);
  });

  it('keeps the own url, or none, for numeric ids from a dataset without the rule', () => {
    expect(publicSourceUrl({ document: '330296', title })).toBeUndefined();
    expect(
      publicSourceUrl({ url: ' https://arkiv.example.no/330296 ', document: '330296', title }),
    ).toBe('https://arkiv.example.no/330296');
    expect(publicSourceUrl({ url: 'digdir://doc/330296', title })).toBe('digdir://doc/330296');
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
});
