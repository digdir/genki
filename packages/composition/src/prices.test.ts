import { describe, expect, it } from 'vitest';
import { CatalogRegistry } from './catalog-registry.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import { checkedPrice, migratePrices, priceMigrationActor } from './prices.js';

const legacy = { inputPerThousand: 0.03, outputPerThousand: 0.12 };
const luna = { 'input-token': 0.00003, 'output-token': 0.00012 };

const storeWith = async (spec: unknown) => {
  const store = new InMemoryConfigEntryStore();
  await store.append({
    kind: 'price',
    scope: platformScope,
    id: 'foundry/gpt-6-luna',
    version: 1,
    spec,
    deleted: false,
    by: 'ola',
    reason: 'pris fra avtalen',
    at: '2026-10-01T00:00:00.000Z',
  });
  return store;
};

const latestPrice = async (store: InMemoryConfigEntryStore) =>
  (await store.latest({ kind: 'price' }))[0];

describe('prices per kind and unit (ADR 0048)', () => {
  it('a stored per-1000 price moves to unit prices for every kind the model binds', async () => {
    const store = await storeWith(legacy);

    expect(await migratePrices({ store, kindsOf: () => ['chat', 'decide'] })).toBe(1);
    expect(await latestPrice(store)).toMatchObject({
      version: 2,
      by: priceMigrationActor,
      spec: { chat: luna, decide: luna },
    });
  });

  it('migrating prices a second time changes nothing', async () => {
    const store = await storeWith(legacy);
    await migratePrices({ store, kindsOf: () => ['chat'] });

    expect(await migratePrices({ store, kindsOf: () => ['chat'] })).toBe(0);
    expect((await latestPrice(store))?.version).toBe(2);
  });

  it('a price names units by their unit names and at least one kind', () => {
    expect(checkedPrice({ chat: { 'input-token': 0.1, Tokens: 1 } }, ['chat']).ok).toBe(false);
    expect(checkedPrice({ chat: { input_token: 0.1 } }, ['chat']).ok).toBe(false);
    expect(checkedPrice({ chat: { 'input-token': -1 } }, ['chat']).ok).toBe(false);
    expect(checkedPrice({}, ['chat']).ok).toBe(false);
    expect(checkedPrice({ embed: { 'input-token': 0.1 } }, ['embed']).ok).toBe(true);
  });

  it('an operator may price a unit that is not built in, such as page', () => {
    const checked = checkedPrice({ ocr: { page: 0.05, request: 0 } }, ['ocr']);
    expect(checked).toEqual({ ok: true, spec: { ocr: { page: 0.05, request: 0 } } });
  });

  it('a price names only a built-in unit or one the API of the model for that kind reports', () => {
    const open = (kind: string) => (kind === 'ocr' ? ['page'] : undefined);
    expect(checkedPrice({ ocr: { page: 0.05, request: 0.1 } }, ['ocr'], open).ok).toBe(true);
    const typo = checkedPrice({ ocr: { pages: 0.05 } }, ['ocr'], open);
    expect(typo.ok).toBe(false);
    if (!typo.ok) {
      expect(typo.errors[0]?.path).toBe('spec.ocr.pages');
      expect(typo.errors[0]?.message).toMatch(/valid units are input-token.*request, page/);
    }
    expect(checkedPrice({ chat: { page: 0.05 } }, ['chat'], open).ok).toBe(false);
  });

  it('a per-1000 price published to the registry is stored per kind and unit', async () => {
    const store = new InMemoryConfigEntryStore();
    const registry = new CatalogRegistry({
      seed: { models: { endpoints: {}, models: [] }, knowledge: {}, rerank: {} },
      store,
      checks: { models: () => [], knowledge: () => [], rerank: () => [] },
      apply: () => {},
      priceKinds: () => ['chat'],
    });
    await registry.initialize();

    const result = await registry.publish({
      kind: 'price',
      scope: platformScope,
      id: 'foundry/gpt-6-luna',
      spec: legacy,
      by: 'ola',
      reason: 'ny pris',
    });

    expect(result.ok).toBe(true);
    expect((await latestPrice(store))?.spec).toEqual({ chat: luna });
  });
});
