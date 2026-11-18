import { describe, expect, it } from 'vitest';
import { apiKeyDigest, InMemoryApiKeys, verifyApiKey, type StoredApiKey } from './index.js';

const key = (): StoredApiKey => ({
  id: 'k1',
  name: 'Skript',
  digest: apiKeyDigest('gp_one'),
  tenant: '991825827',
  scopes: ['query'],
  datasets: [],
  agents: ['*'],
});

const counting = () => {
  const store = new InMemoryApiKeys();
  store.add(key());
  const touches: string[] = [];
  const touch = store.touch.bind(store);
  store.touch = async (id, at) => {
    touches.push(at.toISOString());
    await touch(id, at);
  };
  return { store, touches };
};

const at = (time: string) => new Date(`2026-10-07T${time}Z`);

describe("an API key's last use", () => {
  it('records the last use at most once a minute per key', async () => {
    const { store, touches } = counting();

    await verifyApiKey(store, 'gp_one', at('10:00:00'));
    await verifyApiKey(store, 'gp_one', at('10:00:30'));
    await verifyApiKey(store, 'gp_one', at('10:00:59'));
    await verifyApiKey(store, 'gp_one', at('10:01:00'));

    expect(touches).toEqual(['2026-10-07T10:00:00.000Z', '2026-10-07T10:01:00.000Z']);
    expect((await store.findByDigest(apiKeyDigest('gp_one')))?.lastUsedAt).toBe(
      '2026-10-07T10:01:00.000Z',
    );
  });

  it('records a use again when the stored last use lies in the future', async () => {
    const { store, touches } = counting();
    await store.touch('k1', at('12:00:00'));
    touches.length = 0;

    await verifyApiKey(store, 'gp_one', at('10:00:00'));

    expect(touches).toEqual(['2026-10-07T10:00:00.000Z']);
  });
});
