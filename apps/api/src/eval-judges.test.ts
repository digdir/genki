import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import type { JudgeModel } from '@genai/eval';
import { runJudges } from './eval-judges.js';
import type { ModelChoice } from './model-choice.js';

const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' };

const choiceWith = (calls: unknown[][]) =>
  ({
    usable: async (tenant: string) => {
      calls.push(['usable', tenant]);
      return [];
    },
    pickJudge: (_candidates: unknown[], tenant: string, served: string[]) => {
      calls.push(['pickJudge', tenant, served]);
      return served.includes('foundry/claude-sonnet') ? undefined : 'foundry/claude-sonnet';
    },
    judgeModel: (principal: Principal, tenant: string, model: string, origin: string) => {
      calls.push(['judgeModel', principal.subject, tenant, model, origin]);
      return {
        id: model,
        family: 'anthropic',
        complete: async () => '{"scores": {"criteria": 1}, "rationale": "Fristen er nevnt."}',
      } satisfies JudgeModel;
    },
  }) as unknown as ModelChoice;

describe('judges an eval run gets for itself', () => {
  it("picks the criteria judge's model for the run's tenant, from another family than the writers and the service's own models, and charges it there", async () => {
    const calls: unknown[][] = [];
    const judges = runJudges(() => choiceWith(calls))(kari, { avoid: ['foundry/gpt-4o-mini'] });
    const criteria = judges.get('judge:criteria');

    const scores = await criteria?.evaluate(
      {
        id: 'k',
        split: 'train',
        input: 'Når er fristen?',
        type: 'criteria',
        expected: { sources: [], criteria: { criteria: 'Nevner fristen' } },
        grounding: 'answer-only',
        tags: [],
        needsReview: false,
      },
      { answer: '1. mai', retrieved: [], citations: [] },
      { servedModels: ['foundry/gpt-4o'], modelFamily: () => 'openai' },
    );

    expect(calls.slice(0, 3)).toEqual([
      ['usable', '991825827'],
      ['pickJudge', '991825827', ['foundry/gpt-4o', 'foundry/gpt-4o-mini']],
      ['judgeModel', 'kari', '991825827', 'foundry/claude-sonnet', 'builder'],
    ]);
    expect(criteria?.judge).toBe('judge:criteria@1+foundry/claude-sonnet');
    expect(scores).toMatchObject([{ state: 'scored', value: 1, reason: 'Fristen er nevnt.' }]);
  });

  it('gives a principal without a tenant no criteria judge', () => {
    const operator: Principal = { kind: 'operator', issuer: 'test', subject: 'ops' };

    expect(runJudges(() => choiceWith([]))(operator).has('judge:criteria')).toBe(false);
  });
});
