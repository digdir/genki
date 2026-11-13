import { emptyLayout, type ProfileData } from '@genai/ui-blocks';
import { describe, expect, it } from 'vitest';
import { profileOf, type AssistantProfile } from './profile.js';

// What a service made in the builder carries: its words as data.
const data: ProfileData = {
  assistantName: 'Kunnskapsassistenten',
  suggestions: ['Hva handler dokumentene i Kudos om?'],
  followUps: ['Kan du utdype?'],
  settingsNote: 'Valgene huskes i denne nettleseren.',
  corpora: {
    kudos: {
      label: 'Kudos',
      description: 'dokumenter fra kudos.dfo.no',
      fields: [{ id: 'concerned_years', label: 'År', kind: 'year', years: { first: 1990 } }],
      typeField: 'type',
      documentLinks: { digits: 'https://kudos.dfo.no/documents/{id}' },
    },
    'genki-docs': { label: 'GenKI-dokumentasjon' },
  },
};
const layout = { ...emptyLayout, profile: data };

describe('the profile a layout is drawn with', () => {
  it('is the layout’s when the host gives none', () => {
    expect(profileOf(layout)).toEqual(data);
  });

  it('draws only a layout’s https links, whether or not the layout was checked', () => {
    const drawn = profileOf({
      profile: {
        corpora: {
          kudos: {
            documentLinks: {
              digits: 'https://kudos.dfo.no/documents/{id}',
              uuid: 'http://kudos.dfo.no/dokument/{id}',
              any: 'javascript:alert({id})',
            },
          },
        },
        experiments: [
          { id: 'a', title: 'A', href: 'https://example.org/a', hrefLabel: 'Sak A' },
          { id: 'b', title: 'B', href: 'data:text/html,b', hrefLabel: 'Sak B' },
        ],
      },
    });
    expect(drawn?.corpora?.kudos?.documentLinks).toEqual({
      digits: 'https://kudos.dfo.no/documents/{id}',
    });
    expect(drawn?.experiments?.map((experiment) => experiment.href)).toEqual([
      'https://example.org/a',
      undefined,
    ]);
    expect(drawn?.experiments?.[1]?.hrefLabel).toBeUndefined();
  });

  it('leaves a host’s own links to the host, as before', () => {
    const host: AssistantProfile = {
      corpora: { kudos: { documentLinks: { any: 'http://intranet.example/{id}' } } },
    };
    expect(profileOf(layout, host)?.corpora?.kudos?.documentLinks).toEqual({
      any: 'http://intranet.example/{id}',
    });
  });

  it('is the host’s own, the same object, when the layout carries none', () => {
    const host: AssistantProfile = { assistantName: 'KA' };
    expect(profileOf(emptyLayout, host)).toBe(host);
    expect(profileOf(emptyLayout)).toBeUndefined();
  });

  it('takes what the host sets over the layout’s, and the rest from the layout', () => {
    const host: AssistantProfile = {
      assistantName: 'KA',
      suggestions: ['Hva er fast?'],
      corpora: { kudos: { label: 'Kudos (KA)', typeField: 'doc_type' } },
    };
    expect(profileOf(layout, host)).toEqual({
      assistantName: 'KA',
      suggestions: ['Hva er fast?'],
      followUps: ['Kan du utdype?'],
      settingsNote: 'Valgene huskes i denne nettleseren.',
      corpora: {
        kudos: {
          label: 'Kudos (KA)',
          description: 'dokumenter fra kudos.dfo.no',
          fields: [{ id: 'concerned_years', label: 'År', kind: 'year', years: { first: 1990 } }],
          typeField: 'doc_type',
          documentLinks: { digits: 'https://kudos.dfo.no/documents/{id}' },
        },
        'genki-docs': { label: 'GenKI-dokumentasjon' },
      },
    });
  });

  it('takes a list the host sets whole, an empty one too, and a field it leaves undefined from the layout', () => {
    const host: AssistantProfile = {
      assistantName: undefined,
      suggestions: [],
      corpora: { kudos: { fields: [{ id: 'type', label: 'Dokumenttyper' }], label: undefined } },
    };
    const drawn = profileOf(layout, host);
    expect(drawn?.assistantName).toBe('Kunnskapsassistenten');
    expect(drawn?.suggestions).toEqual([]);
    expect(drawn?.corpora?.kudos?.fields).toEqual([{ id: 'type', label: 'Dokumenttyper' }]);
    expect(drawn?.corpora?.kudos?.label).toBe('Kudos');
  });

  it('keeps what only host code can give: the reader, the menu, the sign-out, the family and a link function', () => {
    const documentUrl = (id: string) => `https://example.org/${id}`;
    const family = (service: string) => service === 'ka';
    const onSelect = () => {};
    const host: AssistantProfile = {
      signedInAs: 'Kari Nordmann',
      organisation: 'Digdir',
      menu: { feedback: { onSelect } },
      signOut: { href: '/auth/logout' },
      family,
      corpora: { kudos: { documentUrl } },
    };
    const drawn = profileOf(layout, host);
    expect(drawn?.signedInAs).toBe('Kari Nordmann');
    expect(drawn?.organisation).toBe('Digdir');
    expect(drawn?.menu?.feedback).toEqual({ onSelect });
    expect(drawn?.signOut).toEqual({ href: '/auth/logout' });
    expect(drawn?.family).toBe(family);
    expect(drawn?.corpora?.kudos?.documentUrl).toBe(documentUrl);
    expect(drawn?.corpora?.kudos?.documentLinks).toEqual(data.corpora?.kudos?.documentLinks);
  });

  it('reads a collection named like an object’s own property only where a profile names it', () => {
    const drawn = profileOf(
      { profile: { corpora: { kudos: { label: 'Kudos' } } } },
      { corpora: { constructor: { label: 'Konstruktør' } } },
    );
    expect(drawn?.corpora).toEqual({
      kudos: { label: 'Kudos' },
      constructor: { label: 'Konstruktør' },
    });
  });
});
