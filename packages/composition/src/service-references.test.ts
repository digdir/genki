import type { CompiledCapability } from '@genai/definitions';
import { serviceLifecycleKind } from '@genai/jobs';
import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { liveServiceReferences } from './runtime.js';

const tenant = '991825827';
const model = 'nimbrel-cortex/cortex';

const service = (id: string) =>
  ({
    capability: { config: { model: { operations: { classify: model } } } },
    service: { tenant, id, version: 1 },
  }) as unknown as CompiledCapability;

const withState = async (id: string, state: 'paused' | 'archived') => {
  const store = new InMemoryConfigEntryStore();
  await store.append({
    kind: serviceLifecycleKind,
    scope: tenant,
    id,
    version: 1,
    spec: { state },
    deleted: false,
    by: 'drift',
    reason: 'test',
    at: '2026-11-20T10:35:00Z',
  });
  return store;
};

describe('service references', () => {
  it('an archived service does not keep a model in use', async () => {
    const store = await withState('test-classify', 'archived');

    const used = await liveServiceReferences([service('test-classify')], store);

    expect(used.models.has(model)).toBe(false);
  });

  it('a paused service still keeps a model in use', async () => {
    const store = await withState('test-classify', 'paused');

    const used = await liveServiceReferences([service('test-classify')], store);

    expect(used.models.has(model)).toBe(true);
  });

  it('archiving one service leaves the model in use by another', async () => {
    const store = await withState('test-classify', 'archived');

    const used = await liveServiceReferences([service('test-classify'), service('live')], store);

    expect(used.models.has(model)).toBe(true);
  });
});
