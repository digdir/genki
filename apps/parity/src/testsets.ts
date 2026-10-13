import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { QualityCase, SourceRef, TestSetFile } from './quality.js';
import type { JsonValue } from './types.js';

export interface TargetTools {
  agent: string;
  probe: string;
  arguments: Record<string, JsonValue>;
  dataset?: string;
  service?: string;
  retrieveService?: string;
  relaxedAgent?: string;
}

export interface TestSetProfile {
  corpus: string;
  old: TargetTools;
  new: TargetTools;
}

export interface LoadedTestSet extends TestSetFile {
  id: string;
  provisional: boolean;
  profile: TestSetProfile;
}

const profilesFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'testsets',
  'targets.json',
);

export const testSetProfiles = (): Record<string, TestSetProfile> =>
  (JSON.parse(readFileSync(profilesFile, 'utf8')) as { testSets: Record<string, TestSetProfile> })
    .testSets;

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

const sourceOf = (v: unknown): SourceRef[] => {
  if (!isRaw(v)) return [];
  const source: SourceRef = {
    ...(typeof v.chunkId === 'string' ? { chunkId: v.chunkId } : {}),
    ...(typeof v.document === 'string' ? { document: v.document } : {}),
    ...(typeof v.position === 'number' ? { position: v.position } : {}),
  };
  return Object.keys(source).length > 0 ? [source] : [];
};

const caseOf = (raw: unknown, i: number): QualityCase & { needsReview: boolean } => {
  if (!isRaw(raw)) throw new Error(`case ${i} is not an object`);
  const expected = isRaw(raw.expected) ? raw.expected : {};
  if (typeof raw.id !== 'string') throw new Error(`case ${i} has no id`);
  if (typeof raw.input !== 'string' || raw.input === '')
    throw new Error(`case ${raw.id} has no text input`);
  return {
    id: raw.id,
    question: raw.input,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    ...(typeof raw.grounding === 'string' ? { grounding: raw.grounding } : {}),
    reference: typeof expected.referenceAnswer === 'string' ? expected.referenceAnswer : null,
    answerPattern: typeof expected.answerPattern === 'string' ? expected.answerPattern : null,
    sources: (Array.isArray(expected.sources) ? expected.sources : []).flatMap(sourceOf),
    needsReview: raw.needsReview === true,
  };
};

export const fromTestSetYaml = (
  text: string,
  source: string,
): TestSetFile & { id: string; needsReview: number } => {
  const raw = parseYaml(text) as unknown;
  if (!isRaw(raw) || raw.kind !== 'TestSet' || !isRaw(raw.metadata) || !isRaw(raw.spec))
    throw new Error(`${source} is not a genai/v1 TestSet`);
  const provenance = isRaw(raw.spec.provenance) ? raw.spec.provenance : {};
  const cases = (Array.isArray(raw.spec.cases) ? raw.spec.cases : []).map(caseOf);
  const status =
    typeof provenance.status === 'string'
      ? provenance.status
      : provenance.from === 'digdir-headless-rag'
        ? 'imported'
        : 'draft';
  return {
    id: String(raw.metadata.id),
    source,
    status,
    needsReview: cases.filter((c) => c.needsReview).length,
    cases: cases.map(({ needsReview: _, ...c }) => c),
  };
};

export const loadTestSet = async (
  path: string,
  profiles: Record<string, TestSetProfile> = testSetProfiles(),
): Promise<LoadedTestSet> => {
  const text = await readFile(path, 'utf8');
  const yaml = ['.yaml', '.yml'].includes(extname(path));
  const parsed = yaml
    ? fromTestSetYaml(text, path)
    : { ...(JSON.parse(text) as TestSetFile), id: basename(path, extname(path)), needsReview: 0 };
  const profile = profiles[parsed.id];
  if (!profile)
    throw new Error(
      `no target profile for test set ${parsed.id}; add it to apps/parity/testsets/targets.json`,
    );
  const { needsReview, ...rest } = parsed;
  return {
    ...rest,
    provisional: parsed.status === 'draft' || needsReview > 0,
    profile,
  };
};
