import { describe, expect, it } from 'vitest';
import { databaseSource, rowCondition, rowMapping, tableQuery } from './database.js';

const mapping = rowMapping.parse({
  table: 'saker',
  fields: {
    id: 'id',
    title: 'tittel',
    text: ['sammendrag', 'vedtak'],
    date: 'avsluttet',
    metadata: ['saksnummer'],
  },
  filter: [{ column: 'status', op: 'eq', value: 'avsluttet' }],
});

const rows = async function* () {
  yield {
    id: 7,
    tittel: 'Klage på vedtak',
    sammendrag: 'Klagen ble tatt til følge.',
    vedtak: null,
    avsluttet: new Date('2026-03-01T00:00:00Z'),
    saksnummer: '2026/7',
  };
  yield { id: 8, tittel: 'Tom sak', sammendrag: '', vedtak: null, saksnummer: '2026/8' };
};

describe('rows from a database table as documents', () => {
  it('turns each row into a document with the mapped title, text, date and metadata', async () => {
    const documents = [];
    for await (const d of databaseSource({
      rows: rows(),
      mapping,
      origin: 'postgres://fag/saker',
    }).documents())
      documents.push(d);

    expect(documents.map((d) => [d.name, d.texts, d.skip])).toEqual([
      ['saker/7', ['# Klage på vedtak\n\nKlagen ble tatt til følge.'], undefined],
      ['saker/8', ['# Tom sak\n\n'], 'no_text'],
    ]);
    expect(documents[0]?.stored([])).toMatchObject({
      title: 'Klage på vedtak',
      lastmod: '2026-03-01T00:00:00.000Z',
      type: 'database',
      source_table: 'saker',
      source_id: '7',
      saksnummer: '2026/7',
    });
    expect(tableQuery(mapping).columns).toEqual([
      'id',
      'tittel',
      'sammendrag',
      'vedtak',
      'avsluttet',
      'saksnummer',
    ]);
  });

  it('accepts only plain names and well-formed conditions', () => {
    expect(rowMapping.safeParse({ ...mapping, table: 'saker; DROP TABLE saker' }).success).toBe(
      false,
    );
    expect(rowMapping.safeParse({ ...mapping, where: '1=1' }).success).toBe(false);
    expect(rowCondition.safeParse({ column: 'status', op: 'in', value: 'avsluttet' }).success).toBe(
      false,
    );
    expect(rowCondition.safeParse({ column: 'status', op: 'is_null', value: 'x' }).success).toBe(
      false,
    );
    expect(rowCondition.safeParse({ column: 'status', op: 'in', value: ['a', 'b'] }).success).toBe(
      true,
    );
  });
});
