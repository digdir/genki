import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { envSecrets, type PortContext } from '@genai/kernel';
import { KnowledgeRouter, type KnowledgePort } from '@genai/port-knowledge';
import { typesense } from '@genai/providers-typesense';
import {
  draftTestSet,
  mapSources,
  parseTestSet,
  parseTestSetYaml,
  sampleCandidates,
  splitFor,
  testSetYaml,
  unreachable,
  type DraftQuestion,
  type TestSet,
} from './index.js';

const DOCS = 'KUDOS_preprod_v4_documents_ab897fbdedfa';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

type Search = Record<string, unknown>;
const fakeTypesense = async (answer: (search: Search) => unknown) => {
  const seen: { path: string; searches: Search[] }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const searches = (JSON.parse(raw || '{}') as { searches?: Search[] }).searches ?? [];
      seen.push({ path: req.url ?? '', searches });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: searches.map(answer) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
};

const example = parseYaml(
  readFileSync(
    join(import.meta.dirname, '..', '..', 'providers-typesense', 'examples', 'kudos.yaml'),
    'utf8',
  ),
) as { endpoints: Record<string, Record<string, unknown>>; datasets: Record<string, unknown>[] };

const context: PortContext = {
  tenant: '991825827',
  principal: { kind: 'operator', issuer: 'test', subject: 'eval' },
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
};

const kudos = (url: string): KnowledgePort =>
  new KnowledgeRouter({
    catalog: {
      endpoints: { 'kudos-typesense': { ...example.endpoints['kudos-typesense'], baseURL: url } },
      datasets: [
        {
          ...example.datasets[0],
          options: {
            ...(example.datasets[0] as { options: Record<string, unknown> }).options,
            docFields: ['url', 'title', 'total_chunks', 'type', 'concerned_years', 'orgs_long'],
          },
        },
      ],
    },
    adapters: [typesense],
    secrets: envSecrets({ TYPESENSE_KEY: 'test' }),
  }).open({ kind: 'dataset', id: 'digdir/kudos' }, context);

const chunkDoc = (id: string, doc: string, position: number, org: string) => ({
  id,
  chunk_id: id,
  doc_num: doc,
  chunk_index: position,
  content_markdown: `Tekst fra ${org} i dokument ${doc}. `.repeat(30),
  [DOCS]: {
    title: `Årsrapport ${org}`,
    type: 'Årsrapport',
    concerned_years: [2024],
    orgs_long: [org],
  },
});

const golden = (): TestSet =>
  parseTestSet({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: { tenant: '991825827', id: 'golden', name: 'golden', version: 1 },
    spec: {
      provenance: { mapping: 'pending' },
      cases: [
        {
          id: 'a',
          split: 'train',
          input: 'a?',
          expected: { sources: [{ chunkId: 'c1' }, { chunkId: 'c2' }] },
        },
        { id: 'b', split: 'holdout', input: 'b?', expected: { sources: [{ chunkId: 'c3' }] } },
      ],
    },
  });

describe('mapping golden chunk ids to document and position', () => {
  it('adds document and position through the knowledge port and keeps the chunk ids', async () => {
    const { url, seen } = await fakeTypesense(() => ({
      hits: [
        { document: chunkDoc('c1', 'd1', 0, 'Digdir') },
        { document: chunkDoc('c2', 'd1', 4, 'Digdir') },
        { document: chunkDoc('c3', 'd9', 2, 'Digdir') },
      ],
    }));
    const port = kudos(url);

    const result = await mapSources(golden(), (ids) => port.fetch(ids), '2026-10-06', 'chunks_x');

    expect(result.mapped).toBe(3);
    expect(result.missing).toEqual([]);
    expect(result.set.spec.cases.map((c) => c.expected.sources)).toEqual([
      [
        { chunkId: 'c1', document: 'd1', position: 0 },
        { chunkId: 'c2', document: 'd1', position: 4 },
      ],
      [{ chunkId: 'c3', document: 'd9', position: 2 }],
    ]);
    expect(result.set.spec.provenance?.mapping).toContain(
      'mapped to document + position against chunks_x',
    );
    expect(seen.every((s) => s.path === '/multi_search')).toBe(true);
  });

  it('records the ids it could not find, and marks a corpus that is not reachable', async () => {
    const partial = await mapSources(
      golden(),
      async (ids) =>
        ids.filter((id) => id !== 'c3').map((id) => ({ id, document: 'd1', position: 1 })),
      '2026-10-06',
      'chunks_x',
    );

    expect(partial.missing).toEqual(['c3']);
    expect(partial.set.spec.provenance).toMatchObject({ unmappedChunkIds: ['c3'] });
    expect(partial.set.spec.cases[1]?.expected.sources).toEqual([{ chunkId: 'c3' }]);
    expect(unreachable(golden(), '2026-10-06', ['a', 'b']).spec.provenance?.mapping).toMatch(
      /^pending: none/,
    );
  });
});

describe('sampling Kudos candidates', () => {
  it('spreads over organisations, skips short chunks and repeated documents, and keeps the metadata', async () => {
    const orgs = ['Digdir', 'NAV', 'Statsbygg'];
    const { url, seen } = await fakeTypesense((search) => {
      if (search.facet_by)
        return {
          facet_counts: [
            { field_name: 'orgs_long', counts: orgs.map((value, i) => ({ value, count: 10 - i })) },
          ],
        };
      const filter = String(search.filter_by ?? '');
      const org = orgs.find((o) => filter.includes(o)) ?? 'Digdir';
      if (search.q === '*') {
        const ids = [...filter.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
        return {
          hits: ids.map((id, i) =>
            id.endsWith('short')
              ? { document: { ...chunkDoc(id, `${org}-s`, 0, org), content_markdown: 'kort' } }
              : { document: chunkDoc(id, `${org}-${id.slice(-1)}`, i, org) },
          ),
        };
      }
      return {
        hits: [`${org}-short`, `${org}-1`, `${org}-2`].map((chunk_id) => ({
          document: { chunk_id },
        })),
      };
    });

    const candidates = await sampleCandidates(
      {
        facets: (fields) => kudos(url).facets(fields),
        search: (request) => kudos(url).search(request as Parameters<KnowledgePort['search']>[0]),
        fetch: (ids) => kudos(url).fetch(ids),
      },
      {
        orgField: 'orgs_long',
        typeField: 'type',
        yearField: 'concerned_years',
        docsKey: DOCS,
        probes: ['mål', 'budsjett'],
        perOrg: 2,
        maxOrgs: 2,
        minTextLength: 100,
      },
    );

    expect(candidates.map((c) => [c.org, c.document])).toEqual([
      ['Digdir', 'Digdir-1'],
      ['Digdir', 'Digdir-2'],
      ['NAV', 'NAV-1'],
      ['NAV', 'NAV-2'],
    ]);
    expect(candidates[0]).toMatchObject({
      type: 'Årsrapport',
      years: [2024],
      title: 'Årsrapport Digdir',
    });
    expect(seen.every((s) => s.path === '/multi_search')).toBe(true);
  });
});

describe('drafting a test set', () => {
  const question = (
    id: string,
    kind: DraftQuestion['kind'],
    sources = [{ chunkId: 'c1', document: 'd1', position: 0 }],
  ): DraftQuestion => ({
    id,
    kind,
    input: `${id}?`,
    sources: kind === 'not-covered' ? [] : sources,
    referenceAnswer: 'svar',
  });

  it('marks every case for review, expects a refusal for not-covered questions, and round-trips through YAML', () => {
    const set = draftTestSet([question('q-1', 'factual'), question('q-2', 'not-covered')], {
      tenant: '991825827',
      id: 'draft',
      name: 'draft',
      corpus: 'digdir/kudos',
      drafted: '2026-10-06',
      collections: ['chunks_x'],
    });

    expect(set.spec.provenance).toMatchObject({ status: 'draft', reviewer: '' });
    expect(set.spec.cases.map((c) => [c.grounding, c.needsReview, c.tags[0]])).toEqual([
      ['sources-and-answer', true, 'factual'],
      ['refusal-expected', true, 'not-covered'],
    ]);
    expect(parseTestSetYaml(testSetYaml(set))).toEqual(set);
  });

  it('refuses a factual question without a source', () => {
    expect(() =>
      draftTestSet([question('q-1', 'factual', [])], {
        tenant: '991825827',
        id: 'draft',
        name: 'draft',
        corpus: 'c',
        drafted: '2026-10-06',
        collections: [],
      }),
    ).toThrow(/needs a source/);
  });

  it('assigns splits deterministically, roughly 60/20/20', () => {
    const counts = { train: 0, validation: 0, holdout: 0 };
    for (let i = 0; i < 2000; i++) counts[splitFor(`case-${i}`)] += 1;

    expect(splitFor('ka-kudos-001-factual')).toBe(splitFor('ka-kudos-001-factual'));
    expect(counts.train / 2000).toBeCloseTo(0.6, 1);
    expect(counts.validation / 2000).toBeCloseTo(0.2, 1);
  });
});

describe('the checked-in test sets', () => {
  const dir = join(import.meta.dirname, '..', 'testsets');

  it.each(readdirSync(dir).filter((f) => f.endsWith('.yaml')))(
    '%s validates and locates every source',
    (file) => {
      const set = parseTestSetYaml(readFileSync(join(dir, file), 'utf8'));
      const sources = set.spec.cases.flatMap((c) => c.expected.sources);

      expect(sources.every((s) => s.document !== undefined && s.position !== undefined)).toBe(true);
    },
  );

  it('keeps the Kudos draft a draft, with a mix of question kinds and no personal numbers', () => {
    const set = parseTestSetYaml(readFileSync(join(dir, 'ka-kudos-draft.yaml'), 'utf8'));
    const kinds = new Set(set.spec.cases.map((c) => c.tags[0]));

    expect(set.spec.provenance).toMatchObject({ status: 'draft', reviewer: '' });
    expect(set.spec.cases.length).toBeGreaterThanOrEqual(60);
    expect(kinds).toEqual(new Set(['factual', 'comparison', 'not-covered']));
    expect(set.spec.cases.every((c) => c.needsReview)).toBe(true);
    expect(JSON.stringify(set)).not.toMatch(/\b\d{11}\b/);
  });
  it('ties the Kudos draft to Kunnskapsassistenten, so the service quality tab lists it', () => {
    const set = parseTestSetYaml(readFileSync(join(dir, 'ka-kudos-draft.yaml'), 'utf8'));

    expect(set.spec.service).toBe('kunnskapsassistenten');
  });
  it('has nynorsk criteria cases that judge the written standard', () => {
    const set = parseTestSetYaml(readFileSync(join(dir, 'nynorsk-sporsmal.yaml'), 'utf8'));
    const criteria = set.spec.cases.filter((c) => c.type === 'criteria');

    expect(criteria.length).toBeGreaterThanOrEqual(5);
    expect(set.spec.cases.every((c) => c.tags.includes('nynorsk'))).toBe(true);
    expect(criteria.every((c) => c.expected.criteria?.criteria?.includes('nynorsk'))).toBe(true);
    expect(criteria.every((c) => c.expected.referenceAnswer === undefined)).toBe(true);
    expect(set.spec.cases.some((c) => c.type === 'must_reject')).toBe(true);
  });
});
