import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envSecrets, type PortContext } from '@genai/kernel';
import {
  KnowledgeRouter,
  type DatasetConfig,
  type IndexDocument,
  type KnowledgePort,
} from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
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

const context: PortContext = {
  tenant: '991825827',
  principal: { kind: 'operator', issuer: 'test', subject: 'eval' },
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
};

const report = (
  id: string,
  org: string,
  chunks: { id: string; position: number; text?: string }[],
): IndexDocument => ({
  id,
  title: `Årsrapport ${org}`,
  fields: { type: 'Årsrapport', concerned_years: [2024], orgs_long: [org] },
  chunks: chunks.map((c) => ({
    id: c.id,
    position: c.position,
    text: c.text ?? `Mål og budsjett fra ${org} i dokument ${id}. `.repeat(5),
  })),
  phrases: [],
});

const kudos = async (docs: IndexDocument[]): Promise<KnowledgePort> => {
  const { adapter, writer } = memoryEngine();
  const store = writer.connect({ engine: 'memory' } as never, {
    signal: new AbortController().signal,
  });
  const dataset = { id: 'digdir/kudos', filters: {}, options: {} } as DatasetConfig<never>;
  await store.prepare(dataset, 'g1');
  for (const doc of docs) await store.store(dataset, 'g1', doc);
  await store.promote(dataset, 'g1');
  return new KnowledgeRouter({
    catalog: {
      endpoints: { lokal: { engine: 'memory' } },
      datasets: [
        {
          id: 'digdir/kudos',
          endpoint: 'lokal',
          residency: 'norway',
          filters: {
            orgs_long: 'multiselect',
            type: 'multiselect',
            concerned_years: 'multiselect',
          },
          options: {},
        },
      ],
    },
    adapters: [adapter],
    secrets: envSecrets({}),
  }).open({ kind: 'dataset', id: 'digdir/kudos' }, context);
};

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
    const port = await kudos([
      report('d1', 'Digdir', [
        { id: 'c1', position: 0 },
        { id: 'c2', position: 4 },
      ]),
      report('d9', 'Digdir', [{ id: 'c3', position: 2 }]),
    ]);

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
    const port = await kudos(
      ['Digdir', 'NAV', 'Statsbygg'].flatMap((org) => [
        report(`${org}-s`, org, [
          { id: `${org}-short`, position: 0, text: 'Mål og budsjett, kort' },
        ]),
        report(`${org}-1`, org, [{ id: `${org}-1-0`, position: 0 }]),
        report(`${org}-2`, org, [{ id: `${org}-2-0`, position: 0 }]),
      ]),
    );

    const candidates = await sampleCandidates(
      {
        facets: (fields) => port.facets(fields),
        search: (request) => port.search(request as Parameters<KnowledgePort['search']>[0]),
        fetch: (ids) => port.fetch(ids),
      },
      {
        orgField: 'orgs_long',
        typeField: 'type',
        yearField: 'concerned_years',
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
  it('the Kudos draft keys every source by UUID, with its earlier id, except the listed ones', () => {
    const set = parseTestSetYaml(readFileSync(join(dir, 'ka-kudos-draft.yaml'), 'utf8'));
    const listed = new Set(
      ((set.spec.provenance?.listedSources ?? []) as { case: string; document: string }[]).map(
        (l) => `${l.case} ${l.document}`,
      ),
    );
    const unkeyed = set.spec.cases.flatMap((c) =>
      c.expected.sources.flatMap((s) =>
        /^kudos:[0-9a-f-]{36}$/.test(s.document ?? '') &&
        /^\d+$/.test(s.earlierDocument ?? '') &&
        s.chunkId === undefined
          ? []
          : listed.has(`${c.id} ${s.document}`)
            ? []
            : [`${c.id} ${s.document}`],
      ),
    );

    expect(unkeyed).toEqual([]);
  });

  it('ties the Kudos draft to Kunnskapsassistenten, so the service quality tab lists it', () => {
    const set = parseTestSetYaml(readFileSync(join(dir, 'ka-kudos-draft.yaml'), 'utf8'));

    expect(set.spec.service).toBe('kunnskapsassistenten');
  });
  it('states in every ka-hierarchy case the register date it was written from', () => {
    const set = parseTestSetYaml(readFileSync(join(dir, 'ka-hierarchy.yaml'), 'utf8'));
    const date = (set.spec.provenance as { registerDate?: string } | undefined)?.registerDate;

    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(set.spec.service).toBe('kunnskapsassistenten');
    expect(set.spec.cases.every((c) => c.tags.includes(`register-${date}`))).toBe(true);
  });

  it('keeps the source out of every ka-hierarchy correctness case and scores citing in separate cites-source cases', () => {
    const set = parseTestSetYaml(readFileSync(join(dir, 'ka-hierarchy.yaml'), 'utf8'));
    const criteriaOf = (c: (typeof set.spec.cases)[number]) => c.expected.criteria?.criteria ?? '';
    const correctness = set.spec.cases.filter((c) => c.tags.includes('correctness'));
    const citing = set.spec.cases.filter((c) => c.tags.includes('cites-source'));
    const kinds = (tag: string) => correctness.filter((c) => c.tags.includes(tag)).length;

    expect(set.spec.cases.every((c) => c.type === 'criteria')).toBe(true);
    expect(correctness.length + citing.length).toBe(set.spec.cases.length);
    expect(correctness.filter((c) => c.tags.includes('cites-source'))).toEqual([]);
    expect([
      kinds('ministry-to-agencies'),
      kinds('agency-to-ministry'),
      kinds('wrote-about'),
    ]).toEqual([8, 8, 4]);
    expect(
      correctness.filter((c) => /enhetsregister|kilde|brønnøysund/i.test(criteriaOf(c))),
    ).toEqual([]);
    expect(citing).toHaveLength(3);
    expect(
      citing.every((c) => /Enhetsregisteret/.test(criteriaOf(c)) && /dato/.test(criteriaOf(c))),
    ).toBe(true);
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
