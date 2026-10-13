// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../api';
import { useAsync } from '../hooks';

afterEach(cleanup);

const server = () => {
  const state = { version: 1, gets: 0, locale: 'nb' };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') state.gets += 1;
    else state.version += 1;
    return new Response(JSON.stringify(method === 'GET' ? { data: [`v${state.version}`] } : {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const api = createApiClient({
    baseUrl: '',
    fetch,
    token: () => 'kari',
    locale: () => state.locale,
  });
  return { state, api };
};

const visit = (api: ReturnType<typeof server>['api'], tenant = '1') => {
  const seen: unknown[] = [];
  const view = renderHook(() => {
    const [state] = useAsync((signal) => api.listDefinitions(tenant, signal), [api, tenant]);
    if (JSON.stringify(seen.at(-1)) !== JSON.stringify(state)) seen.push(state);
    return state;
  });
  return { ...view, seen };
};

describe('the cache in the portal API layer', () => {
  it('shows a cached page on the second visit without waiting and then updates it in the background', async () => {
    const { api, state } = server();
    const first = visit(api);
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    first.unmount();
    state.version = 2;

    const second = visit(api);
    await waitFor(() => expect(second.result.current).toEqual({ status: 'ready', data: ['v2'] }));

    expect(second.seen).toEqual([
      { status: 'loading' },
      { status: 'ready', data: ['v1'] },
      { status: 'ready', data: ['v2'] },
    ]);
    expect(state.gets).toBe(2);
  });

  it('shows no data from before the own write', async () => {
    const { api, state } = server();
    const first = visit(api);
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    first.unmount();

    await act(() => api.datasets.rename('1', 'x', { name: 'Nytt navn' }, 'Test'));

    const second = visit(api);
    expect(second.result.current.status).toBe('loading');
    await waitFor(() => expect(second.result.current).toEqual({ status: 'ready', data: ['v2'] }));
    expect(state.gets).toBe(2);
  });

  it('does not share a cached page between tenants or languages', async () => {
    const { api, state } = server();
    const first = visit(api, '1');
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    first.unmount();

    const other = visit(api, '2');
    expect(other.result.current.status).toBe('loading');
    await waitFor(() => expect(other.result.current.status).toBe('ready'));
    other.unmount();

    state.locale = 'en';
    const english = visit(api, '1');
    expect(english.result.current.status).toBe('loading');
    await waitFor(() => expect(english.result.current.status).toBe('ready'));
    expect(state.gets).toBe(3);
  });
});
