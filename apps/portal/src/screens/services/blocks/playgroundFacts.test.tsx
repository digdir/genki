// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { answered, fakeClient } from './draft.test-utils';
import { usePlaygroundFacts } from './playgroundFacts';

const service = (datasets: string[]) => ({
  id: 'lokal-testchat',
  name: 'Lokal testchat',
  chat: true,
  latestVersion: 1,
  versions: [
    {
      version: 1,
      draft: false,
      inUse: true,
      setup: { model: 'modell-a', datasets, skills: [], blocks: [], output: 'text' as const },
    },
  ],
});

describe('the playground’s facts', () => {
  it('read the playground’s first setup as a draft, with each dataset’s own fields', async () => {
    const { api } = fakeClient(answered('Ja'), { services: [service(['felles/byggeregler'])] });
    const { result } = renderHook(() => usePlaygroundFacts(api, 'eksempel', 'Prøveområde'));
    await waitFor(() =>
      expect(result.current?.datasets).toEqual([
        { tenant: 'felles', key: 'byggeregler', filterFields: ['kommune', 'aar'] },
      ]),
    );
    expect(result.current?.title).toBe('Lokal testchat');
    expect(result.current?.chat).toBe(true);
  });

  it('give a setup that searches nothing no datasets, so its builder offers no Sources', async () => {
    const { api } = fakeClient(answered('Ja'), { services: [service([])] });
    const { result } = renderHook(() => usePlaygroundFacts(api, 'eksempel', 'Prøveområde'));
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current?.datasets).toEqual([]);
  });
});
