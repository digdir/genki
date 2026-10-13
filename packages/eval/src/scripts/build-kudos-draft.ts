import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  draftTestSet,
  testSetYaml,
  type Candidate,
  type DraftQuestion,
  type QuestionKind,
} from '../drafting.js';

interface QuestionSpec {
  refs: number[];
  kind: QuestionKind;
  input: string;
  referenceAnswer?: string;
  answerPattern?: string;
}

const [candidatesFile, questionsFile] = process.argv.slice(2);
if (!candidatesFile || !questionsFile)
  throw new Error('usage: build-kudos-draft <candidates.json> <questions.json>');

const candidates = JSON.parse(readFileSync(candidatesFile, 'utf8')) as Candidate[];
const specs = JSON.parse(readFileSync(questionsFile, 'utf8')) as QuestionSpec[];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'o')
    .replace(/[å]/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const questions: DraftQuestion[] = specs.map((spec, i) => {
  const sources = spec.refs.map((ref) => {
    const c = candidates[ref];
    if (!c) throw new Error(`question ${i} refers to missing candidate ${ref}`);
    return c;
  });
  return {
    id: `ka-kudos-${String(i + 1).padStart(3, '0')}-${spec.kind}`,
    kind: spec.kind,
    input: spec.input,
    sources: sources.map((c) => ({
      chunkId: c.chunkId,
      document: c.document,
      position: c.position,
    })),
    ...(spec.referenceAnswer ? { referenceAnswer: spec.referenceAnswer } : {}),
    ...(spec.answerPattern ? { answerPattern: spec.answerPattern } : {}),
    tags: [
      ...new Set(sources.flatMap((c) => [slug(c.type), ...c.years.map((y) => `year-${y}`)])),
    ].filter(Boolean),
  };
});

const set = draftTestSet(questions, {
  tenant: '991825827',
  id: 'ka-kudos-draft',
  name: 'Kunnskapsassistenten, Kudos (draft)',
  service: 'kunnskapsassistenten',
  corpus: 'digdir/kudos',
  drafted: new Date().toISOString().slice(0, 10),
  collections: ['KUDOS_preprod_v4_chunks_ab897fbdedfa'],
});

const out = join(import.meta.dirname, '..', '..', 'testsets', 'ka-kudos-draft.yaml');
writeFileSync(out, testSetYaml(set));
console.log(JSON.stringify({ cases: set.spec.cases.length, out }));
