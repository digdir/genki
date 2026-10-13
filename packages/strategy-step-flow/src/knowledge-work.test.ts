import { join } from 'node:path';
import type { Part } from '@genai/contracts';
import type { ChatRequest } from '@genai/port-model';
import { describe, expect, it } from 'vitest';
import type { FlowTable } from './blocks/table.js';
import {
  chunk,
  fakeModels,
  loadFlow,
  notices,
  run,
  steps,
  stubRetrieval,
} from './harness.test-utils.js';
import type { FlowChunk, FlowDocument, FlowDocumentQuery, FlowRetrieval } from './services.js';

const example = loadFlow(
  join(import.meta.dirname, '..', '..', 'definitions', 'examples', 'maloppnaelse-flyt.yaml'),
);

const documents: FlowDocument[] = [
  { id: 'd-dfo', title: 'Tildelingsbrev DFØ 2024', url: 'https://kudos.dfo.no/dfo' },
  { id: 'd-digdir', title: 'Årsrapport Digdir 2024', url: 'https://kudos.dfo.no/digdir' },
];

const chunksOf: Record<string, FlowChunk[]> = {
  'd-dfo': [
    chunk('dfo-0', { document: 'd-dfo', content: 'Mål 1: Effektiv lønnstjeneste.' }),
    chunk('dfo-1', { document: 'd-dfo', position: 1, content: 'Resultat: 98 prosent i tide.' }),
  ],
  'd-digdir': [chunk('digdir-0', { document: 'd-digdir', content: 'Mål: Felles løsninger.' })],
};

const documentRetrieval = (read: Record<string, FlowChunk[]> = chunksOf) => {
  const base = stubRetrieval([]);
  const listed: FlowDocumentQuery[] = [];
  const reads: string[] = [];
  const backend: FlowRetrieval = {
    ...(base.factory(undefined, undefined) as FlowRetrieval),
    documents: async (query) => {
      listed.push(query);
      return documents;
    },
    readDocument: async (document, maxChunks) => {
      reads.push(`${document}:${maxChunks}`);
      return read[document] ?? [];
    },
  };
  return { ...base, listed, reads, factory: () => backend };
};

const cited = (request: ChatRequest) => {
  const prompt = request.messages.at(-1)?.content ?? '';
  return prompt.includes('DFØ')
    ? JSON.stringify({
        goals: [
          {
            goal: { value: 'Effektiv lønnstjeneste', sources: [1] },
            target: { value: 'Andel lønn utbetalt i tide', sources: [1] },
            result: { value: '98 prosent', sources: [2] },
          },
        ],
      })
    : JSON.stringify({
        goals: [
          {
            goal: { value: 'Felles løsninger', sources: [1] },
            target: { value: '', sources: [] },
            result: { value: 'Ikke rapportert', sources: [7] },
          },
        ],
      });
};

const tableOf = (result: unknown) =>
  (
    (result as Part[]).find((p) => p.mime === 'application/vnd.genai.table+json')?.body as {
      json: FlowTable;
    }
  ).json;

const csvOf = (result: unknown) =>
  (
    (result as Part[]).find((p) => p.mime === 'text/csv')?.body as {
      text: string;
    }
  ).text;

const input = { data: { virksomheter: ['DFØ', 'DIGDIR'], aar: [2024] } };

describe('step flows over a set of documents', () => {
  it('lists documents by filter, reads each one, extracts with sources and builds a table with a source per cell', async () => {
    const retrieval = documentRetrieval();
    const models = fakeModels({ primary: [cited] });

    const out = await run(
      { flows: [example], entry: 'maloppnaelse-flyt@1', models, retrieval },
      input,
    );

    expect(out.task.status).toBe('completed');
    expect(retrieval.listed).toEqual([
      {
        filters: {
          type: ['Tildelingsbrev', 'Årsrapport'],
          orgs_short: ['DFØ', 'DIGDIR'],
          concerned_years: [2024],
        },
        limit: 200,
      },
    ]);
    expect(retrieval.reads).toEqual(['d-dfo:300', 'd-digdir:300']);
    const request = models.seen[0]?.request;
    expect(request?.messages.at(-1)?.content).toContain('[1] \n```\nTitle: Dokument dfo-0');
    expect(request?.jsonSchema?.schema).toMatchObject({
      properties: {
        goals: {
          items: {
            properties: {
              goal: { properties: { value: { type: 'string' }, sources: { type: 'array' } } },
            },
          },
        },
      },
    });

    const table = tableOf(out.result);
    expect(table.columns.map((c) => c.label)).toEqual([
      'Dokument',
      'Mål',
      'Styringsparameter',
      'Rapportert resultat',
    ]);
    expect(table.skipped).toEqual([]);
    expect(table.rows).toHaveLength(2);
    const [dfo, digdir] = table.rows;
    expect(dfo?.document).toBe('d-dfo');
    expect(dfo?.cells.document).toEqual({
      value: 'Tildelingsbrev DFØ 2024',
      sources: [
        { document: 'd-dfo', title: 'Tildelingsbrev DFØ 2024', url: 'https://kudos.dfo.no/dfo' },
      ],
    });
    expect(dfo?.cells.goal?.value).toBe('Effektiv lønnstjeneste');
    expect(dfo?.cells.goal?.sources.map((s) => s.chunkId)).toEqual(['dfo-0']);
    expect(dfo?.cells.result).toEqual({
      value: '98 prosent',
      sources: [
        {
          chunkId: 'dfo-1',
          document: 'd-dfo',
          title: 'Dokument dfo-1',
          url: 'https://kudos.dfo.no/dfo-1',
          position: 1,
          excerpt: 'Resultat: 98 prosent i tide.',
          headers: ['Kapittel'],
        },
      ],
    });
    expect(digdir?.cells.target).toEqual({ value: '', sources: [] });
    expect(digdir?.cells.result).toEqual({ value: 'Ikke rapportert', sources: [] });

    const csv = csvOf(out.result).split('\r\n');
    expect(csv[0]).toBe(
      'Dokument,Dokument (kilde),Mål,Mål (kilde),Styringsparameter,Styringsparameter (kilde),Rapportert resultat,Rapportert resultat (kilde)',
    );
    expect(csv[1]).toContain('98 prosent,Dokument dfo-1 https://kudos.dfo.no/dfo-1 utdrag dfo-1');
  });

  it('skips and reports a document that fails, and still builds the table from the rest', async () => {
    const retrieval = documentRetrieval({ 'd-dfo': chunksOf['d-dfo'] ?? [] });
    const models = fakeModels({ primary: [cited] });

    const out = await run(
      { flows: [example], entry: 'maloppnaelse-flyt@1', models, retrieval },
      input,
    );

    expect(out.task.status).toBe('completed');
    const table = tableOf(out.result);
    expect(table.rows.map((r) => r.document)).toEqual(['d-dfo']);
    expect(table.skipped).toEqual([
      {
        index: 1,
        document: {
          document: 'd-digdir',
          title: 'Årsrapport Digdir 2024',
          url: 'https://kudos.dfo.no/digdir',
        },
        error: expect.stringContaining('the document d-digdir has no text'),
      },
    ]);
    expect(notices(out.events)).toContainEqual(
      expect.objectContaining({ step: 'per-dokument', item: 1, status: 'failed' }),
    );
    expect(models.seen).toHaveLength(1);
  });

  it('fails the whole run when the loop does not say to skip failing items', async () => {
    const flow = steps('streng', [
      { id: 'liste', block: 'documents@1', params: { limit: 5 } },
      {
        id: 'hver',
        forEach: {
          in: 'liste.documents',
          as: 'dok',
          steps: [{ id: 'les', block: 'read-document@1', input: { document: '{{dok}}' } }],
        },
      },
    ]);

    const out = await run({
      flows: [flow],
      entry: 'streng@1',
      retrieval: documentRetrieval({ 'd-dfo': chunksOf['d-dfo'] ?? [] }),
    });

    expect(out.task.status).toBe('failed');
  });

  it('lists documents by id and keeps the first ids up to the limit', async () => {
    const retrieval = documentRetrieval();
    const flow = steps('ider', [
      {
        id: 'liste',
        block: 'documents@1',
        input: { ids: '{{input.ids}}', filters: { orgs_short: '{{input.mangler}}' } },
        params: { limit: 10 },
      },
    ]);

    const out = await run(
      { flows: [flow], entry: 'ider@1', retrieval },
      { data: { ids: ['d-dfo', ''] } },
    );

    expect(out.task.status).toBe('completed');
    expect(retrieval.listed).toEqual([{ ids: ['d-dfo'], limit: 10 }]);
  });

  it('reranks a document by the question and keeps the best chunks when asked', async () => {
    const retrieval = documentRetrieval();
    const flow = steps('beste', [
      {
        id: 'les',
        block: 'read-document@1',
        input: { document: 'd-dfo', query: 'resultat' },
        params: { topK: 1 },
      },
    ]);

    const out = await run({ flows: [flow], entry: 'beste@1', retrieval });

    expect(out.task.status).toBe('completed');
    expect(retrieval.calls).toEqual([{ method: 'rerank', args: ['resultat', ['dfo-0', 'dfo-1']] }]);
  });

  it('refuses to list documents when the datasets cannot be read document by document', async () => {
    const flow = steps('uten', [{ id: 'liste', block: 'documents@1' }]);

    const out = await run({ flows: [flow], entry: 'uten@1', retrieval: stubRetrieval([]) });

    expect(out.task.status).toBe('failed');
    expect(String(out.result)).toMatch(/cannot be read document by document/);
  });

  it('refuses a cited extraction whose schema has its own citations field', async () => {
    const flow = steps('kollisjon', [
      {
        id: 'ut',
        block: 'extract@1',
        input: { prompt: 'Hent', chunks: [{ chunkId: 'c1', content: 'Tekst.' }] },
        params: {
          schema: { type: 'object', properties: { citations: { type: 'string' } } },
        },
      },
    ]);

    const out = await run({ flows: [flow], entry: 'kollisjon@1' });

    expect(out.task.status).toBe('failed');
    expect(String(out.result)).toMatch(/cannot have a citations field/);
  });
});
