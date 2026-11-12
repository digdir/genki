import { describe, expect, it } from 'vitest';
import { translator } from './i18n';
import { labelOf } from './screens/Audit';
import type { AuditEntry } from './types';

const entry = (action: string, target = ''): AuditEntry => ({
  task: 't1',
  tenant: '991825827',
  action,
  actor: 'operator',
  at: '2026-11-05T10:00:00Z',
  outcome: 'applied',
  target,
  reason: 'test',
});

const operationActions = [
  ['platform.operations.descriptor-upload', 'operation:sak-status'],
  ['platform.operations.descriptor-status', 'operation:sak-status'],
  ['platform.operations.descriptor-withdraw', 'operation:sak-status'],
  ['platform.operations.descriptor-fixture', 'operation:sak-status'],
  ['platform.operations.try', 'operation:sak-status'],
  ['platform.operations.maturity', 'operation-kind:lookup'],
  ['platform.operations.processor-record', 'model-endpoint:azure/processor-record'],
  ['platform.models.classify', 'model:azure/gpt'],
  ['platform.catalog.publish', 'catalog:model-endpoint/azure@1'],
  ['platform.catalog.publish', 'catalog:model-endpoint/azure@2'],
  ['platform.catalog.delete', 'catalog:model-endpoint/azure'],
  ['platform.catalog.publish', 'catalog:model/azure/gpt@1'],
  ['platform.catalog.publish', 'catalog:model/azure/gpt@3'],
  ['platform.catalog.delete', 'catalog:model/azure/gpt'],
  ['platform.catalog.publish', 'catalog:price/azure/gpt@1'],
  ['platform.models.refresh', 'models'],
  ['platform.platform-secret.set', 'secret:azure-key'],
] as const;

describe('audit labels', () => {
  it.each(['nb', 'en'] as const)(
    'Revisjon names every ADR 0047 and ADR 0048 action in plain words in %s',
    (locale) => {
      const t = translator(locale);
      const labels = operationActions.map(([action, target]) => labelOf(entry(action, target), t));
      for (const [i, [action]] of operationActions.entries())
        expect(labels[i], action).not.toBe(t('audit.otherAction'));
      expect(new Set(labels).size).toBe(labels.length);
    },
  );

  it.each(['nb', 'en'] as const)(
    'Revisjon names adding, removing, promoting and rolling back a service environment in %s',
    (locale) => {
      const t = translator(locale);
      const labels = ['add', 'remove', 'promote', 'rollback'].map((step) =>
        labelOf(entry(`platform.service.environments.${step}`, 'service:991825827/svar'), t),
      );
      for (const label of labels) expect(label).not.toBe(t('audit.otherAction'));
      expect(new Set(labels).size).toBe(4);
    },
  );

  it('says whether a connection or model was added or changed, by its catalogue version', () => {
    const t = translator('nb');
    expect(labelOf(entry('platform.catalog.publish', 'catalog:model-endpoint/foundry@1'), t)).toBe(
      'La til tilkobling',
    );
    expect(labelOf(entry('platform.catalog.publish', 'catalog:model-endpoint/foundry@2'), t)).toBe(
      'Endret tilkobling',
    );
    expect(labelOf(entry('platform.catalog.publish', 'catalog:model/foundry/gpt@2'), t)).toBe(
      'Endret modell i katalogen',
    );
    expect(labelOf(entry('platform.operations.descriptor-upload', 'x'), t)).toBe(
      'Lastet opp oppskrift',
    );
  });

  it('names a connection change apart from other catalogue changes', () => {
    const t = translator('nb');
    expect(labelOf(entry('platform.catalog.delete', 'catalog:model-endpoint/azure'), t)).toBe(
      'Fjernet tilkobling',
    );
    expect(labelOf(entry('platform.catalog.publish', 'catalog:dataset/x@1'), t)).toBe(
      'Publiserte i katalogen',
    );
  });
});
