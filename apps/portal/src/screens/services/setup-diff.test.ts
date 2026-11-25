import { describe, expect, it } from 'vitest';
import type { ServiceDefinition } from '../../data/service-definition';
import { areaOfPath, draftChanges, sentenceDiff } from './setup-diff';

const base = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: '1', id: 'x', name: 'X' },
  spec: {
    purpose: 'Svar på spørsmål',
    audience: ['employees'],
    input: { kind: 'question' },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: 'a/one' },
    knowledge: { datasets: [{ dataset: 'ds-1' }] },
    guardrails: { 'pii-before-model': true },
  },
} as unknown as ServiceDefinition;

const edit = (spec: Record<string, unknown>) =>
  ({ ...base, spec: { ...base.spec, ...spec } }) as ServiceDefinition;

describe('draft changes against the published version', () => {
  it('finds no changes when only the key order differs', () => {
    const reordered = JSON.parse(JSON.stringify(base)) as ServiceDefinition;
    expect(draftChanges(base, { ...reordered, spec: { ...reordered.spec } })).toEqual([]);
  });

  it('puts files from the user under Inndata, not under Kilder', () => {
    expect(
      draftChanges(
        base,
        edit({ knowledge: { datasets: [{ dataset: 'ds-1' }], runtimeDocuments: true } }),
      ),
    ).toEqual([{ area: 'input', topic: 'files', kind: 'added' }]);
  });

  it('names the model change with both models and puts it under Modell', () => {
    expect(draftChanges(base, edit({ model: { primary: 'a/two' } }))).toEqual([
      { area: 'model', topic: 'model', kind: 'changed', before: 'a/one', after: 'a/two' },
    ]);
  });

  it('lists datasets and guards one by one as added or removed', () => {
    const changes = draftChanges(
      base,
      edit({
        knowledge: { datasets: [{ dataset: 'ds-2' }] },
        guardrails: { 'pii-before-model': true, 'require-sources': true },
      }),
    );
    expect(changes).toEqual(
      expect.arrayContaining([
        { area: 'sources', topic: 'dataset', kind: 'added', subject: 'ds-2' },
        { area: 'sources', topic: 'dataset', kind: 'removed', subject: 'ds-1' },
        { area: 'guards', topic: 'guard', kind: 'added', subject: 'require-sources' },
      ]),
    );
  });

  it('keeps instructions apart from the rest of the way of working', () => {
    const changes = draftChanges(
      base,
      edit({
        strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar langt.' } },
      }),
    );
    expect(changes.map((c) => c.topic)).toEqual(['instructions']);
  });
});

describe('the risk confirmation in the changes', () => {
  const confirmed = (riskClass: string, reasons: string[], at: string) =>
    edit({
      riskClass,
      riskConfirmation: { riskClass, reasons, by: `test:${at}`, at },
    });

  it('finds no change when only who confirmed the risk and when differ', () => {
    expect(
      draftChanges(
        confirmed('limited', ['Svarer ansatte'], '2026-11-01T10:00:00Z'),
        confirmed('limited', ['Svarer ansatte'], '2026-11-21T10:00:00Z'),
      ),
    ).toEqual([]);
  });

  it('finds a change when the reasons for the risk class change', () => {
    expect(
      draftChanges(
        confirmed('limited', ['Svarer ansatte'], '2026-11-01T10:00:00Z'),
        confirmed('limited', ['Svarer ansatte', 'Leser saker'], '2026-11-21T10:00:00Z'),
      ),
    ).toEqual([{ area: 'risk', topic: 'riskConfirmation', kind: 'changed' }]);
  });
});

describe('sentence diff of the instructions', () => {
  it('marks only the sentences that were added or removed', () => {
    expect(sentenceDiff('Svar kort. Vis kilder.', 'Svar kort. Bruk bokmål. Vis kilder.')).toEqual([
      { kind: 'same', text: 'Svar kort.' },
      { kind: 'added', text: 'Bruk bokmål.' },
      { kind: 'same', text: 'Vis kilder.' },
    ]);
    expect(sentenceDiff('Svar kort. Vis kilder.', 'Svar kort.')).toEqual([
      { kind: 'same', text: 'Svar kort.' },
      { kind: 'removed', text: 'Vis kilder.' },
    ]);
  });
});

describe('problem paths', () => {
  it('maps a problem from the draft checks to the area that fixes it', () => {
    expect(areaOfPath('spec.riskConfirmation')).toBe('risk');
    expect(areaOfPath('spec.strategy.config.instructions')).toBe('purpose');
    expect(areaOfPath('spec.strategy.id')).toBe('how');
    expect(areaOfPath('spec.knowledge.datasets.0')).toBe('sources');
    expect(areaOfPath('spec.unknown')).toBeUndefined();
  });
});
