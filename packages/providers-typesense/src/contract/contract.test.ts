import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  collectionSchemas,
  multiSearchResponse,
  shortHashPattern,
  validateDocument,
  type CollectionNames,
} from './index.js';

const KA: CollectionNames = {
  docs: 'KUDOS_preprod_v4_documents_ab897fbdedfa',
  chunks: 'KUDOS_preprod_v4_chunks_ab897fbdedfa',
  phrases: 'KUDOS_preprod_v4_phrases_ab897fbdedfa',
};

const schemas = collectionSchemas(KA);
const fieldNames = (kind: keyof typeof schemas) => schemas[kind].fields.map((f) => f.name);

interface KudosDataset {
  filters: Record<string, string>;
  options: {
    collections: CollectionNames;
    docFields: string[];
    profiles: Record<
      string,
      {
        collection: keyof CollectionNames;
        queryBy: string[];
        textField: string;
        include?: string[];
        exclude?: string[];
      }
    >;
  };
}

const kudos = (
  parseYaml(
    readFileSync(join(import.meta.dirname, '..', '..', 'examples', 'kudos.yaml'), 'utf8'),
  ) as {
    datasets: KudosDataset[];
  }
).datasets[0] as KudosDataset;

describe('typesense contract: collection schemas', () => {
  it('pins the fields headless-rag creates for KA collections', () => {
    expect(fieldNames('docs')).toEqual([
      'doc_num',
      'url',
      'title',
      'concerned_years',
      'orgs_short',
      'orgs_long',
      'type',
      'total_chunks',
      'last_retrieval_success_at',
      'first_retrieval_failure_at',
      'last_retrieval_failure_at',
      'consecutive_retrieval_failures',
      'retrieval_attempts',
    ]);
    expect(fieldNames('chunks')).toEqual([
      'chunk_id',
      'doc_num',
      'chunk_index',
      'content_markdown',
      'metadata',
      'content_length',
    ]);
    expect(fieldNames('phrases')).toEqual(['chunk_id', 'doc_num', 'search_phrase', 'phrase_vec']);
  });

  it('names collections and points references at the documents collection', () => {
    expect(schemas.chunks.name).toBe(KA.chunks);
    expect(schemas.chunks.fields.find((f) => f.name === 'doc_num')?.reference).toBe(
      `${KA.docs}.doc_num`,
    );
    expect(schemas.phrases.fields.find((f) => f.name === 'doc_num')?.reference).toBe(
      `${KA.docs}.doc_num`,
    );
    expect(collectionSchemas(KA).docs).not.toBe(schemas.docs);
  });

  it('embeds phrases inside Typesense with the 384-dimension MiniLM model', () => {
    const vec = schemas.phrases.fields.find((f) => f.name === 'phrase_vec');
    expect(vec).toMatchObject({
      type: 'float[]',
      num_dim: 384,
      vec_dist: 'cosine',
      embed: { from: ['search_phrase'], model_config: { model_name: 'ts/all-MiniLM-L12-v2' } },
    });
  });

  it('covers every field the KA dataset config searches, reads or filters on', () => {
    const stored = { docs: ['file_sha256', 'files'], chunks: ['id'], phrases: [] as string[] };
    const known = (kind: keyof CollectionNames, field: string) =>
      fieldNames(kind).includes(field) || stored[kind].includes(field);

    expect(kudos.options.collections).toEqual(KA);
    for (const [name, profile] of Object.entries(kudos.options.profiles)) {
      for (const field of [
        ...profile.queryBy,
        profile.textField,
        ...(profile.include ?? []),
        ...(profile.exclude ?? []),
      ]) {
        expect(known(profile.collection, field), `${name}: ${field}`).toBe(true);
      }
    }
    for (const field of [...kudos.options.docFields, ...Object.keys(kudos.filters)]) {
      expect(known('docs', field), field).toBe(true);
    }
  });
});

describe('typesense contract: search responses', () => {
  it('accepts the response shapes headless-rag tests stub', () => {
    const shapes = [
      {
        results: [
          {
            hits: [
              { document: { doc_num: 'doc-a', total_chunks: 5 }, text_match_info: { score: 100 } },
              { document: { doc_num: 'doc-b', total_chunks: 2 }, text_match_info: { score: 80 } },
            ],
          },
        ],
      },
      {
        results: [
          {
            hits: [
              { document: { chunk_id: 'a-0', chunk_index: 0, doc_num: 'doc-a' } },
              { document: { chunk_id: 'a-1', chunk_index: 1, doc_num: 'doc-a' } },
            ],
          },
        ],
      },
      {
        results: [
          {
            facet_counts: [
              {
                field_name: 'type',
                counts: [
                  { value: 'Årsrapport', count: 2874 },
                  { value: 'Tildelingsbrev', count: 1200 },
                ],
              },
            ],
          },
        ],
      },
      {
        results: [
          {
            found: 5,
            hits: [],
            facet_counts: [
              {
                field_name: 'orgs_long',
                counts: [
                  { value: 'Digdir', count: 3 },
                  { value: 'DSB', count: 2 },
                ],
              },
            ],
          },
        ],
      },
      {
        results: [
          { code: 404, error: 'Not found.' },
          { found: 0, hits: [] },
        ],
      },
      {
        results: [
          {
            hits: [
              { document: { chunk_id: 'c1' }, text_match_info: { score: '1157451471441100913' } },
            ],
          },
        ],
      },
      {
        results: [
          {
            hits: [
              {
                document: { chunk_id: 'c1', search_phrase: 'p' },
                hybrid_search_info: { rank_fusion_score: 0.82 },
              },
            ],
          },
        ],
      },
    ];

    for (const shape of shapes) expect(multiSearchResponse.safeParse(shape).success).toBe(true);
  });

  it('refuses malformed responses', () => {
    expect(multiSearchResponse.safeParse({ hits: [] }).success).toBe(false);
    expect(
      multiSearchResponse.safeParse({ results: [{ hits: [{ text_match_info: {} }] }] }).success,
    ).toBe(false);
    expect(
      multiSearchResponse.safeParse({
        results: [{ hits: [{ document: {}, text_match_info: { score: 'high' } }] }],
      }).success,
    ).toBe(false);
  });

  it('validates documents per collection, including the joined document fields', () => {
    expect(
      validateDocument('docs', {
        doc_num: 'd1',
        title: 'Tildelingsbrev 2025',
        concerned_years: [2025],
      }).success,
    ).toBe(true);
    expect(validateDocument('docs', { doc_num: 'd1', total_chunks: '4' }).success).toBe(false);
    expect(validateDocument('chunks', { doc_num: 'd1' }).success).toBe(false);
    expect(
      validateDocument('phrases', { chunk_id: 'c1', search_phrase: 'årsverk Digdir 2022' }).success,
    ).toBe(true);

    const chunk = { chunk_id: 'c1', doc_num: 'd1', chunk_index: 0, content_markdown: 'tekst' };
    expect(
      validateDocument(
        'chunks',
        { ...chunk, [KA.docs]: { title: 'T', url: 'https://kudos.dfo.no/d1', total_chunks: 4 } },
        KA.docs,
      ).success,
    ).toBe(true);
    expect(
      validateDocument('chunks', { ...chunk, [KA.docs]: { total_chunks: 'four' } }, KA.docs)
        .success,
    ).toBe(false);
  });

  it('expects chunk ids shaped like headless-rag short hashes, as in KA retrieval captures', () => {
    for (const id of [
      '00b4743ae007',
      '0496b9155ed8',
      '04fe265dfd69',
      '0754fde85c0f',
      '0808496b7edc',
    ]) {
      expect(id).toMatch(shortHashPattern);
    }
    expect('a-0').not.toMatch(shortHashPattern);
  });
});
