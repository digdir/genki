import { describe, expect, it } from 'vitest';
import {
  databaseConnection,
  databaseSource,
  rowCondition,
  rowMapping,
  tableQuery,
} from './database.js';
import { resolvedConnection, type DatabaseAccess } from './pipeline-sources.js';

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

describe('the connector password of a database pipeline', () => {
  const tenant = '991825827';
  const password = `secret://tenant/${tenant}/connector-arkiv`;
  const access = (hosts: readonly string[] | undefined): DatabaseAccess => ({
    reader: { check: async () => ({ rows: 0 }), rows: async function* () {} },
    secrets: { resolve: async () => 'hemmelig', hostsFor: async () => hosts },
  });
  const source = (host: string) => ({
    kind: 'database' as const,
    connection: databaseConnection.parse({
      engine: 'postgres',
      host,
      database: 'arkiv',
      user: 'leser',
      password,
    }),
    mapping,
  });

  it('a database pipeline does not send the connector password to a host it is not bound to', async () => {
    await expect(
      resolvedConnection(access(['db.example.no']), source('andre.example.no'), tenant),
    ).rejects.toThrow('the database password is not set for andre.example.no');
  });

  it('a database pipeline sends the connector password to the host it is bound to', async () => {
    await expect(
      resolvedConnection(access(['DB.example.no']), source('db.example.no'), tenant),
    ).resolves.toMatchObject({ host: 'db.example.no', password: 'hemmelig' });
    await expect(
      resolvedConnection(access(['https://db.example.no']), source('db.example.no'), tenant),
    ).resolves.toMatchObject({ host: 'db.example.no' });
  });

  it('a connector password bound to no host still reaches the host its pipeline names', async () => {
    await expect(
      resolvedConnection(access([]), source('db.example.no'), tenant),
    ).resolves.toMatchObject({ host: 'db.example.no' });
  });
});
