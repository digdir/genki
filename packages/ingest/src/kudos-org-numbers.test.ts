import { describe, expect, it } from 'vitest';
import { toIndexDocument } from './index-writer.js';
import {
  fillInKudosFields,
  kudosLinkAndAbbreviationFields,
  kudosOrgNumberFields,
  prepareKudosDoc,
} from './kudos.js';

/** An allocation letter as KUDOS lists it: the ministry owns it, the agency receives it. */
const letter = (overrides: Record<string, unknown> = {}) =>
  fillInKudosFields({
    uuid: 'a33bf297-afd2-4b38-992e-b23c8fec3d80',
    title: 'Tildelingsbrev Statens vegvesen 2026 (SD)',
    owners: [
      {
        org_number: 972417904,
        alternative_names: [{ name: 'Samferdselsdepartementet', type: 'display' }],
      },
    ],
    recipients: [
      {
        org_number: 971032081,
        alternative_names: [{ name: 'Statens vegvesen', type: 'display' }],
      },
    ],
    publishers: [],
    ...overrides,
  });

describe('org numbers on a KUDOS document', () => {
  it('stores owner and recipient org numbers on a KUDOS document', () => {
    const doc = prepareKudosDoc(letter(), 1);

    expect(doc.owner_orgnr).toEqual(['972417904']);
    expect(doc.recipient_orgnr).toEqual(['971032081']);
  });

  it('leaves orgs_long as it was', () => {
    const doc = prepareKudosDoc(letter(), 1);

    expect(doc.orgs_long).toEqual(['Samferdselsdepartementet', 'Statens vegvesen']);
  });

  it('skips an organisation without an org number', () => {
    const doc = prepareKudosDoc(
      letter({
        owners: [
          { org_number: null, alternative_names: [{ name: 'Ukjent', type: 'display' }] },
          { org_number: 972417904, alternative_names: [] },
          { org_number: '972417904', alternative_names: [] },
        ],
        recipients: [{ alternative_names: [{ name: 'Statens vegvesen', type: 'display' }] }],
      }),
      1,
    );

    expect(doc.owner_orgnr).toEqual(['972417904']);
    expect(doc).not.toHaveProperty('recipient_orgnr');
  });
  it('leaves out an org number that is not nine digits', () => {
    const doc = prepareKudosDoc(
      letter({
        owners: [
          { org_number: 12345, alternative_names: [] },
          { org_number: '97241790X', alternative_names: [] },
          { org_number: 972417904, alternative_names: [] },
        ],
      }),
      1,
    );

    expect(doc.owner_orgnr).toEqual(['972417904']);
  });
});

describe('filling org numbers on a stored KUDOS document', () => {
  it('gives the fields a fresh ingest of the record would store, in its order', () => {
    const raw = letter();
    const fresh = toIndexDocument('kudos:x', prepareKudosDoc(raw, 4), [], []).fields;
    const before = Object.fromEntries(Object.entries(fresh).filter(([k]) => !k.endsWith('_orgnr')));
    // jsonb gives the keys back in its own order.
    const stored = Object.fromEntries(Object.entries(before).reverse());

    const filled = kudosOrgNumberFields({ id: 'kudos:x', record: raw, fields: stored });

    expect(Object.keys(filled)).toEqual(Object.keys(fresh));
    expect(filled).toEqual(fresh);
  });

  it('leaves the fields as they are when the record has no org numbers', () => {
    const raw = letter({ owners: [{ alternative_names: [] }], recipients: [] });
    const fields = { orgs_long: ['Samferdselsdepartementet'], total_chunks: 1 };

    expect(kudosOrgNumberFields({ id: 'kudos:x', record: raw, fields })).toEqual(fields);
  });
});

/** An organisation as KUDOS lists it, with its abbreviation when it has one. */
const org = (orgNumber: number, display: string, abbreviation?: string) => ({
  org_number: orgNumber,
  alternative_names: [
    { name: display, type: 'display' },
    ...(abbreviation ? [{ name: abbreviation, type: 'abbreviation' }] : []),
    { name: display.toUpperCase(), type: 'official' },
  ],
});

describe('abbreviations and links on a KUDOS document', () => {
  it("orgs_short holds the abbreviations of a Kudos document's owners, recipients and publishers, as KUDOS writes them, once each", () => {
    const doc = prepareKudosDoc(
      letter({
        owners: [org(991825827, 'Digitaliseringsdirektoratet', 'Digdir')],
        recipients: [
          org(983744516, 'Folkehelseinstituttet', 'FHI'),
          org(972417904, 'Samferdselsdepartementet'),
        ],
        // KUDOS lists some actors twice, under the same abbreviation.
        publishers: [org(991825827, 'Digitaliseringsdirektoratet', 'Digdir')],
      }),
      1,
    );

    expect(doc.orgs_short).toEqual(['Digdir', 'FHI']);
  });

  it('ingest and the fill give a Kudos record the same org fields', () => {
    const raw = letter({
      owners: [org(991825827, 'Digitaliseringsdirektoratet', 'Digdir')],
      publishers: [org(974760983, 'Direktoratet for samfunnssikkerhet og beredskap', 'DSB')],
    });
    const fresh = toIndexDocument('kudos:x', prepareKudosDoc(raw, 4), [], []).fields;
    const before = Object.fromEntries(
      Object.entries(fresh).filter(([k]) => k !== 'orgs_short' && !k.endsWith('_orgnr')),
    );
    // jsonb gives the keys back in its own order.
    const stored = Object.fromEntries(Object.entries(before).reverse());

    const filled = kudosLinkAndAbbreviationFields({ id: 'kudos:x', record: raw, fields: stored });

    expect(Object.keys(filled.fields)).toEqual(Object.keys(fresh));
    expect(filled.fields).toEqual(fresh);
  });

  it('a stored Kudos document has its page on Kudos as its url', () => {
    const raw = letter();

    const filled = kudosLinkAndAbbreviationFields({ id: 'kudos:x', record: raw, fields: {} });

    expect(filled.url).toBe('https://kudos.dfo.no/dokument/a33bf297-afd2-4b38-992e-b23c8fec3d80');
  });
});

describe('a stored KUDOS record without an id', () => {
  it('gives no url when the record names neither a UUID nor a KUDOS id', () => {
    const filled = kudosLinkAndAbbreviationFields({
      id: 'kudos:x',
      record: { owners: [] },
      fields: {},
    });

    expect(filled).not.toHaveProperty('url');
  });
});

describe('the links and abbreviations fill on records that change', () => {
  it('the fill drops an abbreviation the record no longer gives', () => {
    const raw = letter();
    const stored = { orgs_long: ['Samferdselsdepartementet'], orgs_short: ['OLD'] };

    const filled = kudosLinkAndAbbreviationFields({ id: 'kudos:x', record: raw, fields: stored });

    expect(filled.fields).not.toHaveProperty('orgs_short');
  });

  it('the fill leaves a record that is not from KUDOS as it is', () => {
    const fields = { orgs_long: ['Etaten'], orgs_short: ['ET'], title: 'Side' };

    const filled = kudosLinkAndAbbreviationFields({
      id: 'folder:a',
      record: { id: 'a', path: '/docs/a.md', lastmod: '2026-11-01' },
      fields,
    });

    expect(filled).toEqual({ fields });
  });
});
