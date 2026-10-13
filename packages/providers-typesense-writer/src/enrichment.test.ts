import { describe, expect, it } from 'vitest';
import type { DatasetConfig } from '@genai/port-knowledge';
import { typesenseDatasetOptions } from '@genai/providers-typesense';
import { typesenseIndexWriter } from './adapter.js';
import { questionsFilter } from './enrichment.js';
import { SharedClusterRefused } from './writer.js';

interface Seen {
  method: string;
  url: string;
  body?: string;
}

const fakeFetch = (reply: (seen: Seen) => { status: number; body?: unknown }) => {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request: Seen = {
      method: init?.method ?? 'GET',
      url: String(input),
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    seen.push(request);
    const { status, body } = reply(request);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), { status });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
};

const options = (embedPhrases = true) =>
  typesenseDatasetOptions.parse({
    collections: { docs: 'kudos_docs', chunks: 'kudos_chunks', questions: 'kudos_questions' },
    profiles: {
      questions: { collection: 'questions', queryBy: ['question'], textField: 'question' },
    },
    writer: { embedPhrases },
  });

const dataset = (embedPhrases = true): DatasetConfig =>
  ({
    id: '991825827/kudos',
    endpoint: 'local',
    residency: 'norway',
    filters: {},
    options: options(embedPhrases),
  }) as unknown as DatasetConfig;

const credential = { kind: 'api-key' as const, key: async () => 'local-key' };

const connect = (fetch: typeof globalThis.fetch, baseURL = 'http://localhost:8108') =>
  typesenseIndexWriter({ fetch, sharedClusterUrls: ['search.shared.example'] }).connect(
    { engine: 'typesense', baseURL, credential } as never,
    { signal: new AbortController().signal },
  ) as unknown as {
    enrichment: {
      replaceQuestions(d: DatasetConfig, rows: unknown[], chunkIds: string[]): Promise<number>;
      revertQuestions(d: DatasetConfig, chunkId: string, promptHash?: string): Promise<number>;
    };
  };

const row = {
  id: 'r1',
  chunk_id: 'c1',
  doc_num: 'd1',
  question: 'Hva er fristen?',
  model: 'm',
  generated_at: 1,
  prompt_hash: 'abc',
};

describe('typesense enrichment store', () => {
  it('creates the questions collection, deletes the earlier rows of the chunks, then upserts the new ones', async () => {
    const { seen, fetch } = fakeFetch((r) => {
      if (r.method === 'GET') return { status: 404 };
      if (r.url.includes('/import')) return { status: 200, body: '{"success":true}' };
      if (r.method === 'DELETE') return { status: 404 };
      return { status: 201 };
    });

    expect(await connect(fetch).enrichment.replaceQuestions(dataset(false), [row], ['c1'])).toBe(1);

    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      'GET /collections/kudos_questions',
      'POST /collections',
      'DELETE /collections/kudos_questions/documents',
      'POST /collections/kudos_questions/documents/import',
    ]);
    const schema = JSON.parse(seen[1]?.body ?? '{}') as {
      fields: { name: string; reference?: string }[];
    };
    expect(schema.fields.map((f) => f.name)).toEqual([
      'chunk_id',
      'doc_num',
      'question',
      'model',
      'prompt_hash',
      'generated_at',
    ]);
    expect(schema.fields[1]?.reference).toBe('kudos_docs.doc_num');
    expect(new URL(seen[2]?.url ?? '').searchParams.get('filter_by')).toBe('chunk_id:=[`c1`]');
    expect(JSON.parse(seen[3]?.body ?? '{}')).toEqual(row);
  });

  it('embeds questions for hybrid search unless the dataset turns phrase embedding off', async () => {
    const { seen, fetch } = fakeFetch((r) =>
      r.method === 'GET' ? { status: 404 } : { status: 200, body: '{"success":true}' },
    );
    await connect(fetch).enrichment.replaceQuestions(dataset(), [row], []);
    const schema = JSON.parse(seen[1]?.body ?? '{}') as { fields: { name: string }[] };
    expect(schema.fields.map((f) => f.name)).toContain('question_vec');
  });

  it('fails the apply when Typesense refuses a row, instead of reporting success', async () => {
    const { fetch } = fakeFetch((r) =>
      r.url.includes('/import')
        ? { status: 200, body: '{"success":false,"error":"Field doc_num: Value cannot be empty."}' }
        : { status: 200 },
    );
    await expect(
      connect(fetch).enrichment.replaceQuestions(dataset(), [row], ['c1']),
    ).rejects.toThrow(/doc_num/);
  });

  it('reverts one chunk scoped to a prompt hash and treats no matching rows as zero', async () => {
    const { seen, fetch } = fakeFetch(() => ({ status: 200, body: { num_deleted: 3 } }));
    expect(await connect(fetch).enrichment.revertQuestions(dataset(), 'c1', 'abc')).toBe(3);
    expect(new URL(seen[0]?.url ?? '').searchParams.get('filter_by')).toBe(
      questionsFilter(['c1'], 'abc'),
    );
    expect(questionsFilter(['c1'], 'abc')).toBe('chunk_id:=[`c1`] && prompt_hash:=[`abc`]');

    const missing = fakeFetch(() => ({ status: 404 }));
    expect(await connect(missing.fetch).enrichment.revertQuestions(dataset(), 'c1')).toBe(0);
  });

  it('never writes enrichment to the shared search cluster', () => {
    const { fetch } = fakeFetch(() => ({ status: 200 }));
    expect(() => connect(fetch, 'https://search.shared.example')).toThrow(SharedClusterRefused);
  });
});
