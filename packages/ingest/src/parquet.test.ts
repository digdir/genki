import { describe, expect, it } from 'vitest';
import {
  documentId,
  huggingFaceFile,
  huggingFaceFileUrl,
  huggingFaceOrigin,
  missingColumns,
  parquetColumns,
  lookupKey,
  parquetLookup,
  parquetLookupTable,
  parquetMapping,
  parquetSource,
  type SourceDocument,
} from './index.js';

const mapping = parquetMapping.parse({
  fields: {
    id: 'id',
    title: 'title',
    text: ['summary', 'notes'],
    url: 'official_url',
    date: 'date_published',
    year: 'date_published',
    metadata: [{ column: 'id', as: 'record_id' }, 'legal_force', 'safety_topics'],
    constants: { doc_kind: 'record' },
  },
});

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'EU-03',
  title: 'Artificial Intelligence Act',
  summary: 'Sets rules for AI systems by risk.',
  notes: null,
  official_url: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
  date_published: '2024-06-13',
  legal_force: 'Binding',
  safety_topics: ['general-purpose / frontier AI', null, 'transparency & labelling'],
  ...extra,
});

const documents = async (rows: Record<string, unknown>[], m = mapping, origin = 'hf://x/y') => {
  const out: SourceDocument[] = [];
  for await (const d of parquetSource({ rows, mapping: m, origin }).documents()) out.push(d);
  return out;
};

describe('Parquet source', () => {
  it('writes one document per row, with the title on a bold first line, the text columns and the metadata as lines', async () => {
    const [doc] = await documents([row()]);

    expect(doc?.texts[0]).toBe(
      [
        '**Artificial Intelligence Act**',
        '',
        'Sets rules for AI systems by risk.',
        '',
        '- Record id: EU-03',
        '- Legal force: Binding',
        '- Safety topics: general-purpose / frontier AI, transparency & labelling',
        '- Source: https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
      ].join('\n'),
    );
    expect(doc?.url).toBe('https://eur-lex.europa.eu/eli/reg/2024/1689/oj');
  });

  it('stores metadata as filterable fields: lists stay lists, nulls are dropped, the year is a number and constants are added', async () => {
    const [doc] = await documents([row({ legal_force: null })]);
    const stored = doc?.stored([]);

    expect(stored).toMatchObject({
      record_id: 'EU-03',
      safety_topics: ['general-purpose / frontier AI', 'transparency & labelling'],
      year: 2024,
      lastmod: '2024-06-13',
      doc_kind: 'record',
      type: 'parquet',
      source_id: 'EU-03',
      title: 'Artificial Intelligence Act',
    });
    expect(stored).not.toHaveProperty('legal_force');
  });

  it('gives each row a stable id from its origin and id column, so two files never collide', async () => {
    const [a] = await documents([row()], mapping, 'hf://datasets/o/n/data/records.parquet');
    const [b] = await documents([row()], mapping, 'hf://datasets/o/n/data/other.parquet');

    expect(a?.key).toBe(documentId('hf://datasets/o/n/data/records.parquet#EU-03'));
    expect(a?.key).not.toBe(b?.key);
  });

  it('skips a row without an id, reads a repeated id once and marks a row without text as no_text', async () => {
    const docs = await documents([
      row({ id: '' }),
      row(),
      row({ title: 'Repeat' }),
      row({ id: 'EU-04', summary: '', notes: null }),
    ]);

    expect(docs.map((d) => [d.name, d.skip])).toEqual([
      ['hf://x/y#EU-03', undefined],
      ['hf://x/y#EU-04', 'no_text'],
    ]);
  });

  it('keeps only rows that match every filter, also inside list columns', async () => {
    const filtered = parquetMapping.parse({
      ...mapping,
      filter: [
        { column: 'legal_force', op: 'eq', value: 'Binding' },
        { column: 'safety_topics', op: 'in', value: ['transparency & labelling'] },
        { column: 'official_url', op: 'not_null' },
      ],
    });

    const docs = await documents(
      [
        row(),
        row({ id: 'US-01', legal_force: 'Non-binding' }),
        row({ id: 'CN-01', safety_topics: ['child safety'] }),
        row({ id: 'JP-01', official_url: null }),
      ],
      filtered,
    );

    expect(docs.map((d) => d.name)).toEqual(['hf://x/y#EU-03']);
  });

  it('resolves a Hugging Face file to its resolve URL and an origin without the revision', () => {
    const file = huggingFaceFile.parse({
      dataset: 'kelkalot/every-ai-policy-ever',
      file: 'data/records.parquet',
    });

    expect(huggingFaceFileUrl(file)).toBe(
      'https://huggingface.co/datasets/kelkalot/every-ai-policy-ever/resolve/main/data/records.parquet',
    );
    expect(huggingFaceOrigin({ ...file, revision: 'v1.18' } as never)).toBe(
      'hf://datasets/kelkalot/every-ai-policy-ever/data/records.parquet',
    );
  });

  it('refuses a Hugging Face path that leaves the dataset or is not a Parquet file', () => {
    const parse = (file: string) => huggingFaceFile.safeParse({ dataset: 'o/n', file }).success;

    expect(parse('data/records.parquet')).toBe(true);
    expect(parse('../secrets.parquet')).toBe(false);
    expect(parse('data/records.csv')).toBe(false);
    expect(huggingFaceFile.safeParse({ dataset: 'no-owner', file: 'a.parquet' }).success).toBe(
      false,
    );
  });

  it('refuses a mapping that stores a field the source sets itself, or stores a name twice', () => {
    const parse = (metadata: unknown[], constants = {}) =>
      parquetMapping.safeParse({
        fields: { id: 'id', title: 'title', text: ['summary'], metadata, constants },
      }).success;

    expect(parse(['legal_force'])).toBe(true);
    expect(parse(['year'])).toBe(false);
    expect(parse([{ column: 'id', as: 'title' }])).toBe(false);
    expect(parse(['status'], { status: 'x' })).toBe(false);
  });

  it('names the mapped columns a file lacks', () => {
    expect(parquetColumns(mapping)).toContain('safety_topics');
    expect(missingColumns(mapping, ['id', 'title', 'summary', 'notes', 'official_url'])).toEqual([
      'date_published',
      'legal_force',
      'safety_topics',
    ]);
  });
});

describe('Parquet lookup keys', () => {
  it('matches keys as trimmed text, so a number and its text form are the same key, and never matches an empty or list key', async () => {
    const lookup = parquetLookup.parse({
      url: 'https://x.example/l.parquet',
      key: 'id',
      on: 'ref',
      fields: ['name'],
    });
    const table = await parquetLookupTable(
      [
        { id: 5, name: 'five' },
        { id: ' A-1 ', name: 'a' },
        { id: '', name: 'empty' },
        { id: ['x'], name: 'list' },
        { id: null, name: 'none' },
      ],
      lookup,
      'l.parquet',
    );

    expect([...table.values.keys()]).toEqual(['5', 'A-1']);
    expect(table.rows).toBe(5);
    expect([lookupKey('5'), lookupKey(5), lookupKey(5n), lookupKey('A-1 ')]).toEqual([
      '5',
      '5',
      '5',
      'A-1',
    ]);
    expect([
      lookupKey(''),
      lookupKey('  '),
      lookupKey(['5']),
      lookupKey(null),
      lookupKey({}),
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
