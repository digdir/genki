import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { parseTestSet, type Split, type TestSet } from './schema.js';

export interface FacetValue {
  value: string;
  count: number;
}

export interface SampledChunk {
  id: string;
  document?: string;
  position?: number;
  title?: string;
  text: string;
  fields: Record<string, unknown>;
}

export interface SearchPort {
  facets(fields: string[]): Promise<Record<string, FacetValue[]>>;
  search(request: {
    query: string;
    profile?: string;
    filters?: Record<string, unknown>;
    limit?: number;
  }): Promise<{ hits: { id: string }[] }>;
  fetch(ids: string[]): Promise<SampledChunk[]>;
}

export interface Candidate {
  chunkId: string;
  document: string;
  position: number;
  title: string;
  org: string;
  type: string;
  years: number[];
  probe: string;
  text: string;
}

export interface SampleOptions {
  orgField: string;
  typeField: string;
  yearField: string;
  docsKey: string;
  probes: string[];
  perOrg: number;
  maxOrgs: number;
  minTextLength: number;
}

export const defaultSampleOptions: SampleOptions = {
  orgField: 'orgs_long',
  typeField: 'type',
  yearField: 'concerned_years',
  docsKey: 'KUDOS_preprod_v4_documents_ab897fbdedfa',
  probes: ['mål og resultater', 'budsjett og tildeling', 'risiko', 'digitalisering', 'samarbeid'],
  perOrg: 2,
  maxOrgs: 40,
  minTextLength: 400,
};

const joinedDoc = (chunk: SampledChunk, docsKey: string) =>
  (chunk.fields[docsKey] ?? {}) as Record<string, unknown>;

const firstString = (value: unknown) =>
  Array.isArray(value)
    ? typeof value[0] === 'string'
      ? value[0]
      : undefined
    : typeof value === 'string'
      ? value
      : undefined;

const numbers = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];

export const sampleCandidates = async (
  port: SearchPort,
  options: SampleOptions = defaultSampleOptions,
): Promise<Candidate[]> => {
  const facets = await port.facets([options.orgField]);
  const ranked = (facets[options.orgField] ?? [])
    .filter((f) => f.count >= options.perOrg)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  const step = Math.max(1, ranked.length / options.maxOrgs);
  const orgs = [
    ...new Set(
      Array.from({ length: Math.min(options.maxOrgs, ranked.length) }, (_, i) =>
        Math.floor(i * step),
      ),
    ),
  ].map((i) => ranked[i] as FacetValue);
  const seenDocuments = new Set<string>();
  const candidates: Candidate[] = [];
  for (const [index, org] of orgs.entries()) {
    const picked: Candidate[] = [];
    for (let p = 0; p < options.probes.length && picked.length < options.perOrg; p++) {
      const probe = options.probes[(index + p) % options.probes.length] as string;
      const { hits } = await port.search({
        query: probe,
        profile: 'content',
        filters: { [options.orgField]: [org.value] },
        limit: 5,
      });
      const chunks = await port.fetch(hits.map((h) => h.id));
      const chunk = chunks.find(
        (c) =>
          c.document !== undefined &&
          !seenDocuments.has(c.document) &&
          c.text.length >= options.minTextLength,
      );
      if (!chunk?.document) continue;
      seenDocuments.add(chunk.document);
      const doc = joinedDoc(chunk, options.docsKey);
      picked.push({
        chunkId: chunk.id,
        document: chunk.document,
        position: chunk.position ?? 0,
        title: chunk.title ?? firstString(doc.title) ?? '',
        org: org.value,
        type: firstString(doc[options.typeField]) ?? '',
        years: numbers(doc[options.yearField]),
        probe,
        text: chunk.text,
      });
    }
    candidates.push(...picked);
  }
  return candidates;
};

export const splitFor = (id: string): Split => {
  const bucket = createHash('sha256').update(id).digest().readUInt32BE(0) % 100;
  return bucket < 60 ? 'train' : bucket < 80 ? 'validation' : 'holdout';
};

export const questionKinds = ['factual', 'comparison', 'not-covered'] as const;
export type QuestionKind = (typeof questionKinds)[number];

export interface DraftQuestion {
  id: string;
  kind: QuestionKind;
  input: string;
  sources: { chunkId: string; document: string; position: number }[];
  referenceAnswer?: string;
  answerPattern?: string;
  tags?: string[];
}

export interface DraftMeta {
  tenant: string;
  id: string;
  name: string;
  service?: string;
  corpus: string;
  drafted: string;
  collections: string[];
}

export const draftTestSet = (questions: DraftQuestion[], meta: DraftMeta): TestSet =>
  parseTestSet({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: { tenant: meta.tenant, id: meta.id, name: meta.name, version: 1 },
    spec: {
      ...(meta.service ? { service: meta.service } : {}),
      corpus: meta.corpus,
      provenance: {
        status: 'draft',
        reviewer: '',
        drafted: meta.drafted,
        draftedBy: 'Claude, from text retrieved through the platform search',
        collections: meta.collections,
        sourceIdentity: 'document + position',
      },
      cases: questions.map((q) => {
        if (q.kind !== 'not-covered' && q.sources.length === 0)
          throw new Error(`question ${q.id} needs a source`);
        return {
          id: q.id,
          split: splitFor(q.id),
          input: q.input,
          expected: {
            sources: q.sources,
            ...(q.answerPattern ? { answerPattern: q.answerPattern } : {}),
            ...(q.referenceAnswer ? { referenceAnswer: q.referenceAnswer } : {}),
          },
          grounding: q.kind === 'not-covered' ? 'refusal-expected' : 'sources-and-answer',
          tags: [q.kind, ...(q.tags ?? [])],
          needsReview: true,
        };
      }),
    },
  });

export const testSetYaml = (set: TestSet) => stringify(set, { lineWidth: 0 });
