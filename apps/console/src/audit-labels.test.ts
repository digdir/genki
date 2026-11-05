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
  ['platform.catalog.delete', 'catalog:model-endpoint/azure'],
] as const;

describe('audit labels', () => {
  it.each(['nb', 'en'] as const)(
    'names every ADR 0047 action instead of other action in %s',
    (locale) => {
      const t = translator(locale);
      for (const [action, target] of operationActions)
        expect(labelOf(entry(action, target), t), action).not.toBe(t('audit.otherAction'));
    },
  );

  it('names a model endpoint change apart from other catalogue changes', () => {
    const t = translator('nb');
    expect(labelOf(entry('platform.catalog.publish', 'catalog:model-endpoint/azure@1'), t)).toBe(
      'La til modellendepunkt',
    );
    expect(labelOf(entry('platform.catalog.delete', 'catalog:model-endpoint/azure'), t)).toBe(
      'Fjernet modellendepunkt',
    );
    expect(labelOf(entry('platform.catalog.publish', 'catalog:dataset/x@1'), t)).toBe(
      'Publiserte i katalogen',
    );
  });
});
