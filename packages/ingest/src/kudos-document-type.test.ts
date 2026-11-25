import { describe, expect, it } from 'vitest';
import { fillInKudosFields, kudosDocumentTypeFields, prepareKudosDoc } from './kudos.js';

const record = (type: string) =>
  fillInKudosFields({
    uuid: '51fe0107-75c8-40df-9be4-a1942ae099d2',
    title: 'Årsrapport Helsedirektoratet 2023',
    type,
    owners: [{ org_number: 983544622, alternative_names: [] }],
    recipients: [],
    publishers: [],
  });

describe('the document type of a KUDOS record', () => {
  it('an ingest stores the type KUDOS gives as document_type, beside type', () => {
    const fields = prepareKudosDoc(record(' Årsrapport '), 1);
    expect(fields.document_type).toBe('Årsrapport');
    expect(fields.type).toBe(' Årsrapport ');
  });

  it('stores no document_type for a record without a type', () => {
    expect(prepareKudosDoc(record(''), 1)).not.toHaveProperty('document_type');
    expect(prepareKudosDoc(record('  '), 1)).not.toHaveProperty('document_type');
  });

  it('the fill writes document_type on a stored KUDOS document, and leaves another source as it is', () => {
    const kudos = record('Tildelingsbrev');
    const stored = {
      id: 'kudos:1',
      record: kudos,
      fields: { title: kudos.title, type: 'Tildelingsbrev' },
    };
    expect(kudosDocumentTypeFields(stored)).toEqual({
      title: kudos.title,
      type: 'Tildelingsbrev',
      document_type: 'Tildelingsbrev',
    });
    const website = { id: 'web:1', record: { url: 'https://x.no' }, fields: { type: 'website' } };
    expect(kudosDocumentTypeFields(website)).toEqual({ type: 'website' });
  });
});
