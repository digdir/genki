import { describe, expect, it } from 'vitest';
import { builtinBlocks } from './builtins.js';
import {
  contextFromChunks,
  evaluateEvidence,
  parseCitations,
  renumberCitations,
  validateCitations,
} from './blocks/retrieval.js';
import { evaluateCondition, render, resolvePath, type Scope } from './expressions.js';
import { steps } from './harness.test-utils.js';
import { detectInsufficientContext, systemPromptWithDate } from './prompts.js';
import { checkFlow } from './validate.js';

const scope: Scope = {
  input: { query: 'Hva?', claim: '', items: [1, 2, 3] },
  config: { model: { primary: 'm' } },
  vars: { variant: 'bundled', item: { name: 'Kari' } },
  steps: {
    classify: { status: 'done', output: { label: 'klage', score: 0.8 } },
    skipped: { status: 'skipped', output: null },
  },
};

describe('expressions', () => {
  it('resolves steps by short and long form, input, vars and config', () => {
    expect(resolvePath('classify.label', scope)).toBe('klage');
    expect(resolvePath('steps.classify.output.label', scope)).toBe('klage');
    expect(resolvePath('steps.skipped.status', scope)).toBe('skipped');
    expect(resolvePath('input.items.length', scope)).toBe(3);
    expect(resolvePath('item.name', scope)).toBe('Kari');
    expect(resolvePath('config.model.primary', scope)).toBe('m');
    expect(resolvePath('missing.field', scope)).toBeUndefined();
  });

  it('falls back with ?? past empty values', () => {
    expect(resolvePath('input.claim ?? input.query', scope)).toBe('Hva?');
    expect(resolvePath("skipped.text ?? 'standard'", scope)).toBe('standard');
  });

  it('keeps a whole-template value as it is and interpolates mixed text', () => {
    expect(render('{{input.items}}', scope)).toEqual([1, 2, 3]);
    expect(render('Etikett: {{classify.label}} ({{classify.score}})', scope)).toBe(
      'Etikett: klage (0.8)',
    );
    expect(render({ a: ['{{vars.variant}}'] }, scope)).toEqual({ a: ['bundled'] });
  });

  it('evaluates conditions with comparisons and negation', () => {
    expect(evaluateCondition("classify.label == 'klage'", scope)).toBe(true);
    expect(evaluateCondition('classify.score >= 0.9', scope)).toBe(false);
    expect(evaluateCondition('!skipped.text', scope)).toBe(true);
    expect(evaluateCondition('input.items', scope)).toBe(true);
  });
});

describe('citations', () => {
  const index = { 1: 'a', 2: 'b', 3: 'c' };

  it('renumbers cited sources to start at 1 in order', () => {
    const text = 'Først [3], så [1] og [3] igjen, ukjent [7].';
    const renumbered = renumberCitations(text, parseCitations(text, index), index);

    expect(renumbered.text).toBe('Først [2], så [1] og [2] igjen, ukjent [7].');
    expect(renumbered.citations).toEqual([
      { index: 1, chunkId: 'a' },
      { index: 2, chunkId: 'c' },
    ]);
    expect(validateCitations(renumbered.text, renumbered.index)).toEqual({
      validIndices: [1, 2],
      invalidIndices: [7],
      allValid: false,
      totalReferences: 3,
      grounded: true,
    });
  });

  it('calls an answer without citations ungrounded', () => {
    expect(validateCitations('Bare kunnskap.', index).grounded).toBe(false);
  });
});

describe('context and evidence', () => {
  it('assembles context like headless-rag rerank, with title, headers and a length cap', () => {
    const context = contextFromChunks(
      [
        { chunkId: 'a', content: 'Tekst {12} a', title: 'T', headers: ['H1', 'H2', 'H3'] },
        { chunkId: 'a', content: 'duplikat' },
        { chunkId: 'b' },
        { chunkId: 'c', content: 'x'.repeat(100) },
      ],
      10,
      40,
    );

    expect(context.docs[0]?.content).toBe(
      '\n```\nTitle: T\n### H1\n#### H2\n#### H3\n```\n\nTekst  a',
    );
    expect(context.docs.map((d) => d.source)).toEqual(['a']);
  });

  it('declines an uncorroborated overview on a single score spike', () => {
    const decision = evaluateEvidence(
      [
        { chunkId: 'a', rerankScore: 1 },
        { chunkId: 'b', rerankScore: 0.2 },
      ],
      [{}, {}],
      {
        minContextDocs: 2,
        minSupportingChunks: 2,
        supportScoreRatio: 0.6,
        minDistinctDocuments: 1,
      },
    );
    expect(decision.reason).toBe('uncorroborated');
  });
});

describe('prompts', () => {
  it('dates the system prompt in Norwegian time', () => {
    expect(systemPromptWithDate(new Date('2026-12-31T23:30:00Z'))).toBe(
      'You are a helpful assistant. The date this conversation was created at is 1. januar 2027 (Norwegian time).',
    );
  });

  it('detects insufficient context in Norwegian and English', () => {
    expect(detectInsufficientContext('Jeg finner ikke informasjon om dette.').signal).toBe(
      'finner-ikke-i-kildene',
    );
    expect(
      detectInsufficientContext('There is not enough information in the sources.').signal,
    ).toBe('not-enough-info');
    expect(detectInsufficientContext('Svaret er 42 [1].').insufficient).toBe(false);
    expect(
      detectInsufficientContext('Det står ingenting om saken, men informasjon finnes.')
        .insufficient,
    ).toBe(false);
  });
});

describe('flow checks', () => {
  it('finds unknown blocks, bad params and references to steps that come later', () => {
    const flow = steps('broken', [
      { id: 'first', block: 'template@1', input: { text: '{{later.text}}' } },
      { id: 'nope', block: 'unknown@1' },
      { id: 'labels', block: 'classify@1', params: { labels: ['bare-en'] } },
      { id: 'later', block: 'template@1', input: { text: 'x' } },
      {
        id: 'each',
        forEach: {
          in: 'input.items',
          as: 'item',
          steps: [{ id: 'use', block: 'template@1', input: { text: '{{item}}' } }],
        },
      },
    ]);

    expect(checkFlow(flow, builtinBlocks()).map((p) => p.path)).toEqual([
      'spec.steps[0].input',
      'spec.steps[1].block',
      'spec.steps[2].params.labels',
    ]);
  });
});
