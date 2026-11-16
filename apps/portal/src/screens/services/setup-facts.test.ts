import { describe, expect, it } from 'vitest';
import { actorLabel } from '../../format';
import { applySpec, asServiceDefinition } from '../../data/service-definition';
import { translator } from '../../i18n';
import { latestRunFact } from '../../api/quality';
import { defaultKeyCallsPerMinute } from '../../data/integrations';
import { summaries } from './SetupTab';

const t = translator('nb');
const en = translator('en');

const definition = (spec: Record<string, unknown>) =>
  asServiceDefinition({
    metadata: { id: 'x', name: 'X' },
    spec: { output: { kind: 'answer' }, model: { primary: 'm', residency: 'global' }, ...spec },
  });

describe('setup summaries', () => {
  it('say a service on a ready-made strategy uses its default instructions', () => {
    const c = definition({ strategy: { id: 'agent-loop', config: {} } });
    expect(summaries(t, c).instructions).toBe('Standardinstruksjonene til oppsettet');
  });

  it('point to the step flow when a step flow service has no own instructions', () => {
    const c = definition({ strategy: { id: 'step-flow', config: { flow: 'flyt@1' } } });
    expect(summaries(t, c).instructions).toBe('I stegene i stegflyten flyt@1');
  });

  it('show written instructions as written', () => {
    const c = definition({
      strategy: { id: 'single-call', config: { instructions: 'Svar kort.' } },
    });
    expect(summaries(t, c).instructions).toBe('Svar kort.');
  });

  it('list the guardrails the definition configures', () => {
    const c = definition({
      strategy: { id: 'agent-loop', config: {} },
      guardrails: { 'require-sources': true },
    });
    expect(summaries(t, c).guards).toBe('kilder kreves');
  });

  it('name the reranker the definition configures, in the language of the screen', () => {
    const c = definition({
      strategy: { id: 'agent-loop', config: {} },
      knowledge: { datasets: [{ dataset: 'digdir/kudos' }], reranker: 'colbert' },
    });
    expect(summaries(t, c).knowledge).toBe('digdir/kudos · omrangering med ColBERT');
    expect(summaries(en, c).knowledge).toBe('digdir/kudos · reranked with ColBERT');
  });
});

describe('who and numbers shown for versions', () => {
  it('shows the stored name of the person, never a made-up one', () => {
    expect(actorLabel('employee:x:1', t, 'Kari Testansatt')).toBe('Kari Testansatt');
    expect(actorLabel('employee:x:1', t)).toBe('Ansatt i virksomheten');
  });

  it('labels seeded versions as made by the platform', () => {
    expect(actorLabel('platform:seed', t)).toBe('Plattformen');
    expect(actorLabel('worker:seed', en)).toBe('The platform');
  });

  it('writes the latest quality run in the language of the screen', () => {
    expect(latestRunFact([], en)).toBe('Not run');
    const run = {
      status: 'completed',
      total: 4,
      passed: 3,
      startedAt: '2026-10-09T10:00:00Z',
    } as unknown as Parameters<typeof latestRunFact>[0][number];
    expect(latestRunFact([run], en)).toBe('3 of 4 (75%)');
  });

  it('uses the server default of 120 calls per minute for keys', () => {
    expect(defaultKeyCallsPerMinute).toBe(120);
  });

  it('name the workspace as the workspace and list registered own frontends in the start summary', () => {
    const c = applySpec(definition({}), { exposure: { chat: true } });

    expect(summaries(t, c, undefined, undefined, ['Kunnskapsassistenten']).start).toBe(
      'KI-arbeidsflaten (plattformens chat), egne brukerflater: Kunnskapsassistenten',
    );
    expect(summaries(en, c, undefined, undefined, ['Kunnskapsassistenten']).start).toBe(
      "AI workspace (the platform's chat), own frontends: Kunnskapsassistenten",
    );
    expect(summaries(t, c).start).toBe('KI-arbeidsflaten (plattformens chat)');
  });

  it('show a registered own frontend even when no start is ticked', () => {
    const c = definition({});

    expect(summaries(t, c, undefined, undefined, ['Kunnskapsassistenten']).start).toBe(
      'egne brukerflater: Kunnskapsassistenten',
    );
  });
});
