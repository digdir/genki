import { describe, expect, it } from 'vitest';
import { parseJudgePrompt, parseTestSetYaml, type EvalContext, type TestCase } from '@genai/eval';
import { chrF, klarsprakChecklist, lix, nynorskReference } from './index.js';
import { letters, publishedStore, readExample } from './kit.test-utils.js';

const ctx: EvalContext = { servedModels: ['gpt-4o-test'], modelFamily: () => 'openai' };
const observation = (text: string) => ({
  answer: '',
  retrieved: [],
  citations: [],
  fields: { text },
});

describe('shared services', () => {
  it('publishes klarspråk and nynorsk with their prompts, triggers and batch', async () => {
    const compiled = await (await publishedStore()).capabilities();

    expect(compiled.map((c) => c.publicName)).toEqual(['klarsprak__default', 'nynorsk__default']);
    expect(compiled[0]?.capability.descriptor.interaction).toContain('async');
  });

  it('ships test sets and a judge that parse, with one letter per klarspråk case', () => {
    const klarsprak = parseTestSetYaml(readExample('testsets/klarsprak-brev.yaml'));
    const nynorsk = parseTestSetYaml(readExample('testsets/nynorsk-referanse.yaml'));
    const judge = parseJudgePrompt(readExample('judges/klarsprak-checklist.yaml'));

    expect(klarsprak.spec.cases.map((c) => c.id).sort()).toEqual(
      letters()
        .map((l) => l.id)
        .sort(),
    );
    expect(nynorsk.spec.cases.every((c) => c.expected.referenceAnswer)).toBe(true);
    expect(judge.criteria.map((c) => c.id)).toContain('meaning-preserved');
  });
});

describe('klarspråk checklist', () => {
  const set = parseTestSetYaml(readExample('testsets/klarsprak-brev.yaml'));

  it('scores every reference rewrite higher than its bureaucratic original', async () => {
    const evaluator = klarsprakChecklist();
    for (const c of set.spec.cases) {
      const overall = async (text: string) =>
        (await evaluator.evaluate(c, observation(text), ctx)).find(
          (s) => s.metric === 'klarsprak.overall',
        )?.value ?? 0;
      expect(await overall(c.expected.referenceAnswer ?? '')).toBeGreaterThan(
        await overall(c.input as string),
      );
    }
  });

  it('computes LIX on ordinary text', () => {
    expect(lix('Du får pengene. Vi betaler i mai.')).toBeCloseTo(32.1, 1);
  });
});

describe('nynorsk reference', () => {
  const testCase = parseTestSetYaml(readExample('testsets/nynorsk-referanse.yaml')).spec
    .cases[0] as TestCase;

  it('gives a perfect match full chrF and no bokmål words', async () => {
    const scores = await nynorskReference().evaluate(
      testCase,
      observation(testCase.expected.referenceAnswer ?? ''),
      ctx,
    );

    expect(scores.find((s) => s.metric === 'nynorsk.chrf')?.value).toBeCloseTo(1, 5);
    expect(scores.find((s) => s.metric === 'nynorsk.no-bokmal-words')?.value).toBe(1);
  });

  it('marks an untranslated bokmål answer down on both', async () => {
    const scores = await nynorskReference().evaluate(
      testCase,
      observation(testCase.input as string),
      ctx,
    );

    expect(scores.find((s) => s.metric === 'nynorsk.chrf')?.value).toBeLessThan(0.9);
    expect(scores.find((s) => s.metric === 'nynorsk.no-bokmal-words')).toMatchObject({
      details: { found: ['hvis', 'ikke', 'ikke'] },
    });
  });

  it('scores unrelated text near zero', () => {
    expect(chrF('Sola skin over fjorden.', 'Søknadsfristen er 1. mars.')).toBeLessThan(0.3);
  });
});
