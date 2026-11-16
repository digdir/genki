import { describe, expect, it } from 'vitest';
import { toIndexDocument } from './index-writer.js';
import { fillInKudosFields, kudosOrgNumberFields, prepareKudosDoc } from './kudos.js';

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
