import { describe, expect, it } from 'vitest';
import { createWorkspaceApi } from './api';
import { plausibleYears } from './years';

describe('plausibleYears', () => {
  it('lists only plausible years, newest first, for a year filter', () => {
    const values = ['2438', '2024', '2035', '2027', '1899', '1900', 'ukjent', '2026', '2019'].map(
      (value, i) => ({ value, count: i + 1 }),
    );
    expect(plausibleYears(values, new Date('2026-10-12')).map((v) => v.value)).toEqual([
      '2027',
      '2026',
      '2024',
      '2019',
      '1900',
    ]);
  });

  it('does not offer future years from the index as choices in a service form', async () => {
    const next = String(new Date().getFullYear() + 1);
    const fetcher = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'rapport',
              _chat: true,
              input_fields: [
                {
                  id: 'concerned_years',
                  label: 'År',
                  kind: 'multi-choice',
                  options: ['2035', '2034', next, '2024', '2019'],
                },
                { id: 'type', label: 'Type', kind: 'choice', options: ['2035', 'Årsrapport'] },
              ],
            },
          ],
        }),
      )) as unknown as typeof fetch;
    const api = createWorkspaceApi({ baseUrl: '/api', fetch: fetcher, token: () => 'tok' });

    const [service] = await api.listServices();

    expect(service?.inputFields?.[0]?.options).toEqual([next, '2024', '2019']);
    expect(service?.inputFields?.[1]?.options).toEqual(['2035', 'Årsrapport']);
  });
});
