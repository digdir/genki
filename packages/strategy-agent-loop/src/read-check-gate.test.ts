import { describe, expect, it } from 'vitest';
import {
  aggregateReadSignals,
  recordReadEvaluation,
  Workspace,
  type EvidencePlan,
} from './index.js';
import { call, readSignal, result, run, section } from './harness.test-utils.js';

const gates = (out: Awaited<ReturnType<typeof run>>) =>
  out.notices.filter((n) => n.stage === 'gate');

const loopTurns = (out: Awaited<ReturnType<typeof run>>) =>
  out.seen.filter((s) => s.kind === 'loop').length;

const covering =
  (status: string, support: 'explicit' | 'partial', extra: Record<string, unknown> = {}) =>
  (prompt: string) => {
    const plan = JSON.parse(section(prompt, 'Evidence plan JSON:') ?? '{"required_claims":[]}') as {
      required_claims: { claim_id: string }[];
    };
    const chunks = JSON.parse(section(prompt, 'Newly read chunks JSON:') ?? '[]') as {
      chunk_id: string;
    }[];
    return readSignal(status, {
      supported_claims: plan.required_claims.map((c) => ({
        claim_id: c.claim_id,
        support,
        chunk_ids: chunks.map((x) => x.chunk_id),
      })),
      remaining_gaps: [],
      ...extra,
    });
  };

const plan: EvidencePlan = {
  query: 'q',
  queryIntent: {
    'answer-type': 'lookup',
    entity: null,
    'year-or-date': null,
    metric: null,
    'doc-family-preference': null,
    'scope-signals': [],
  },
  requiredClaims: [
    { claimId: 'topic-match', text: 'Topic matches query', kind: 'topic', critical: true },
    {
      claimId: 'answer-bearing-evidence',
      text: 'Contains answer-bearing details',
      kind: 'support',
      critical: true,
    },
  ],
};

describe('the gate after a read check', () => {
  it('a read that reports gap-remaining does not finalize the loop', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c2'] })]),
          ],
          read: [covering('gap-remaining', 'explicit')],
          sufficiency: [() => JSON.stringify({ status: 'sufficient' })],
        },
      },
    });

    expect(loopTurns(out)).toBeGreaterThanOrEqual(3);
    expect(gates(out)[0]).not.toMatchObject({
      source: 'shadow-read-signals',
      status: 'sufficient',
    });
  });

  it('partial support does not cover a critical claim for the shadow decision', () => {
    const w = new Workspace({ searches: 4, reads: 6, readChars: 12000 });
    w.evidencePlan = plan;
    recordReadEvaluation(w, {
      status: 'support-found',
      scopeAssessment: 'aligned',
      supportedClaims: plan.requiredClaims.map((c) => ({
        claimId: c.claimId,
        supportLevel: 'partial' as const,
        chunkIds: ['c1'],
      })),
      partialClaims: [],
      remainingGaps: [],
      contradictions: [],
      nextActionHint: 'finalize',
      confidence: 0.9,
      degraded: false,
      evaluationMode: 'llm',
      chunkIds: ['c1'],
    });

    expect(w.openGaps.map((g) => g.claimId)).toEqual(['topic-match', 'answer-bearing-evidence']);
    expect(aggregateReadSignals(w)).toMatchObject({
      status: 'insufficient',
      missingClaims: ['topic-match', 'answer-bearing-evidence'],
    });
  });

  it('a shadow sufficient without aligned support-found still asks the sufficiency gate', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3', 'c4', 'c5'] })]),
            () => result('', [call('search', { queries: ['y'] })]),
          ],
          read: [covering('support-found', 'explicit', { scope_assessment: 'partially-aligned' })],
          sufficiency: [
            () =>
              JSON.stringify({
                status: 'insufficient',
                reasoning: 'only the contents page',
                missing_info: ['the causes'],
                contradiction_detected: false,
                suggested_strategy: 're-search',
              }),
          ],
        },
      },
    });

    expect(out.seen.filter((s) => s.kind === 'sufficiency')).toHaveLength(1);
    expect(gates(out).filter((n) => n.source === 'shadow-read-signals')).toEqual([]);
    expect(loopTurns(out)).toBeGreaterThanOrEqual(3);
  });

  it('a gate that finds the sources hold after a gap-remaining read names the read status it overrode', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1', 'c2', 'c3', 'c4', 'c5'] })]),
            () => result('', [call('generate_response', { query: 'x' })]),
          ],
          read: [() => readSignal('gap-remaining')],
          synth: [() => 'Svar [1].'],
        },
      },
    });

    expect(gates(out).at(-1)).toMatchObject({
      source: 'llm-sufficiency-gate',
      status: 'sufficient',
      overriddenReadStatus: 'gap-remaining',
    });
  });

  it('an aligned support-found read with every critical claim explicit still finalizes', async () => {
    const out = await run({
      scripts: {
        primary: {
          loop: [
            () => result('', [call('search', { queries: ['x'] })]),
            () => result('', [call('read_chunks', { chunk_ids: ['c1'] })]),
          ],
        },
      },
    });

    expect(loopTurns(out)).toBe(2);
    expect(out.seen.filter((s) => s.kind === 'sufficiency')).toHaveLength(0);
    expect(gates(out)).toEqual([
      expect.objectContaining({
        source: 'shadow-read-signals',
        status: 'sufficient',
        strategy: 'finalize',
      }),
    ]);
  });
});
