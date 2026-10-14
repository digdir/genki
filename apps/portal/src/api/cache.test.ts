import { describe, expect, it } from 'vitest';
import { createResponseCache, markPageLoad, onRefreshed } from './cache';

const page = () => {
  const signal = new AbortController().signal;
  markPageLoad(signal);
  return signal;
};

const source = (...replies: unknown[]) => {
  let calls = 0;
  return {
    fetcher: async () => replies[Math.min(calls++, replies.length - 1)],
    calls: () => calls,
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the stale-while-revalidate cache for page loads', () => {
  it('shows the cached answer at once on the next visit and refreshes it in the background', async () => {
    let time = 0;
    const cache = createResponseCache({ now: () => time });
    const api = source('old', 'new');

    expect(await cache.load('k', 't', api.fetcher, page())).toBe('old');
    time = 5000;
    expect(await cache.load('k', 't', api.fetcher, page())).toBe('old');
    await settle();
    expect(api.calls()).toBe(2);
    expect(await cache.load('k', 't', api.fetcher, page())).toBe('new');
  });

  it('does not refetch when a page reloads itself after a background refresh', async () => {
    const cache = createResponseCache();
    const api = source('a', 'b');
    const reload = new AbortController().signal;
    markPageLoad(reload, true);

    await cache.load('k', 't', api.fetcher, page());
    expect(await cache.load('k', 't', api.fetcher, reload)).toBe('a');

    expect(api.calls()).toBe(1);
  });

  it('keeps a different answer per key, so another tenant or language never sees it', async () => {
    const cache = createResponseCache();

    await cache.load('t1|nb|/tenants/t1/x', 't1', async () => 'one', page());

    expect(await cache.load('t2|nb|/tenants/t2/x', 't2', async () => 'two', page())).toBe('two');
    expect(await cache.load('t1|en|/tenants/t1/x', 't1', async () => 'three', page())).toBe(
      'three',
    );
  });

  it('serves no stale data after the own write: a write drops the tenant entries', async () => {
    let time = 0;
    const cache = createResponseCache({ now: () => time });
    const api = source('before', 'after');

    await cache.load('k', 't1', api.fetcher, page());
    cache.invalidate('t1');
    time = 5000;

    expect(await cache.load('k', 't1', api.fetcher, page())).toBe('after');
  });

  it('keeps the entries of other tenants when one tenant is written', async () => {
    const cache = createResponseCache();
    await cache.load('a', 't1', async () => 1, page());
    await cache.load('b', 't2', async () => 2, page());

    cache.invalidate('t1');

    expect(cache.size()).toBe(1);
  });

  it('drops a refresh that started before a write', async () => {
    let time = 0;
    const cache = createResponseCache({ now: () => time });
    let release: (value: string) => void = () => undefined;
    await cache.load('k', 't', async () => 'old', page());
    time = 5000;
    await cache.load('k', 't', () => new Promise<string>((r) => (release = r)), page());

    cache.invalidate('t');
    release('stale');
    await settle();

    expect(cache.size()).toBe(0);
  });

  it('tells the page that read a key when a background refresh changed it', async () => {
    let time = 0;
    const cache = createResponseCache({ now: () => time });
    const api = source('old', 'new');
    const signal = page();
    let told = 0;
    onRefreshed(signal, () => (told += 1));

    await cache.load('k', 't', api.fetcher, signal);
    const first = told;
    time = 5000;
    await cache.load('k', 't', api.fetcher, signal);
    await settle();

    expect(told - first).toBe(1);
  });

  it('does not tell the page load that fetched the answer itself, so it does not load twice', async () => {
    const cache = createResponseCache();
    const signal = page();
    let told = 0;
    onRefreshed(signal, () => (told += 1));

    await cache.load('k', 't', async () => 'first', signal);

    expect(told).toBe(0);
  });

  it('always fetches when the caller is not a page load, and still updates the cache', async () => {
    const cache = createResponseCache({ now: () => 0 });
    const api = source('a', 'b');

    await cache.load('k', 't', api.fetcher, page());
    expect(await cache.load('k', 't', api.fetcher)).toBe('b');
    expect(await cache.load('k', 't', api.fetcher, page())).toBe('b');
  });

  it('keeps the old answer when the background refresh fails', async () => {
    let time = 0;
    const cache = createResponseCache({ now: () => time });
    await cache.load('k', 't', async () => 'old', page());
    time = 5000;

    expect(await cache.load('k', 't', () => Promise.reject(new Error('down')), page())).toBe('old');
    await settle();
    expect(await cache.load('k', 't', async () => 'x', page())).toBe('old');
  });
});
