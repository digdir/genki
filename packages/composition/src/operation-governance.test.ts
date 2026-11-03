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

  it('promoting a kind to production needs a second person', async () => {
    const store = new InMemoryConfigEntryStore();
    const governance = operationGovernance(store, 'production');
    await record(store, 'production', 'operator:test:drift');
    const pending = await governance.maturityOf('classify');
    expect(pending).toMatchObject({
      maturity: 'test',
      promotion: { by: 'operator:test:drift' },
    });
    expect(maturityStep(pending, 'production', 'operator:test:vakt')).toBe('promoted');
    await record(store, 'production', 'operator:test:vakt');
    expect(await governance.maturityOf('classify')).toMatchObject({
      maturity: 'production',
      promotedBy: ['operator:test:drift', 'operator:test:vakt'],
    });
  });

  it('the same person cannot confirm their own promotion', async () => {
    const store = new InMemoryConfigEntryStore();
    const governance = operationGovernance(store, 'production');
    await record(store, 'production', 'operator:test:drift');
    expect(
      maturityStep(await governance.maturityOf('classify'), 'production', 'operator:test:drift'),
    ).toBe('own-promotion');
    await record(store, 'production', 'operator:test:drift');
    expect(await governance.maturity('classify')).toBe('test');
  });

  it('one person demotes a kind, and the next promotion needs two people again', async () => {
    const store = new InMemoryConfigEntryStore();
    const governance = operationGovernance(store, 'production');
    await record(store, 'production', 'operator:test:drift');
    await record(store, 'production', 'operator:test:vakt');
    expect(
      maturityStep(await governance.maturityOf('classify'), 'test', 'operator:test:vakt'),
    ).toBe('demoted');
    await record(store, 'test', 'operator:test:vakt');
    expect(await governance.maturity('classify')).toBe('test');
    await record(store, 'production', 'operator:test:drift');
    expect(await governance.maturity('classify')).toBe('test');
  });

  it('maturity is kept per environment', async () => {
    const store = new InMemoryConfigEntryStore();
    await record(store, 'production', 'operator:test:drift');
    await record(store, 'production', 'operator:test:vakt');
    expect(await operationGovernance(store, 'production').maturity('classify')).toBe('production');
    expect(await operationGovernance(store, 'test').maturity('classify')).toBe('test');
  });
});
