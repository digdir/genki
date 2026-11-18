import { describe, expect, it } from 'vitest';
import { appendVersion, InMemoryConfigEntryStore } from './config-store.js';
import {
  maturityEntryKind,
  maturityStep,
  operationGovernance,
  type MaturityRecord,
} from './operation-governance.js';

const record = (store: InMemoryConfigEntryStore, maturity: 'test' | 'production', by: string) =>
  appendVersion<MaturityRecord>(store, {
    kind: maturityEntryKind,
    scope: 'production',
    id: 'classify',
    spec: { maturity },
    deleted: false,
    by,
    reason: 'Endrer modenheten i testen',
  });

describe('maturity per operation kind', () => {
  it('a kind is in test until someone moves it', async () => {
    const governance = operationGovernance(new InMemoryConfigEntryStore(), 'production');
    expect(await governance.maturity('classify')).toBe('test');
  });

  it('one operator promotes a kind to production, recorded with who and when', async () => {
    const store = new InMemoryConfigEntryStore();
    const governance = operationGovernance(store, 'production');
    expect(maturityStep(await governance.maturityOf('classify'), 'production')).toBe('promoted');
    await record(store, 'production', 'operator:test:drift');
    expect(await governance.maturityOf('classify')).toMatchObject({
      maturity: 'production',
      by: 'operator:test:drift',
      at: expect.any(String),
    });
  });

  it('one operator moves a kind back to test', async () => {
    const store = new InMemoryConfigEntryStore();
    const governance = operationGovernance(store, 'production');
    await record(store, 'production', 'operator:test:drift');
    expect(maturityStep(await governance.maturityOf('classify'), 'test')).toBe('demoted');
    await record(store, 'test', 'operator:test:drift');
    expect(await governance.maturityOf('classify')).toMatchObject({
      maturity: 'test',
      by: 'operator:test:drift',
    });
    expect(await store.history(maturityEntryKind, 'production', 'classify')).toHaveLength(2);
  });

  it('asking for the maturity a kind already has changes nothing', async () => {
    const store = new InMemoryConfigEntryStore();
    const governance = operationGovernance(store, 'production');
    expect(maturityStep(await governance.maturityOf('classify'), 'test')).toBe('unchanged');
    await record(store, 'production', 'operator:test:drift');
    expect(maturityStep(await governance.maturityOf('classify'), 'production')).toBe('unchanged');
  });

  it('maturity is kept per environment', async () => {
    const store = new InMemoryConfigEntryStore();
    await record(store, 'production', 'operator:test:drift');
    expect(await operationGovernance(store, 'production').maturity('classify')).toBe('production');
    expect(await operationGovernance(store, 'test').maturity('classify')).toBe('test');
  });
});
