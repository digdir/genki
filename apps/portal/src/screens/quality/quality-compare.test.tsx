// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import type { EvalRun } from '../../api/quality';
import type { CaseChange } from '../../api/service-tabs';
import { CasesSection, CompareSection } from './QualityOverview';

document.getAnimations ??= () => [];
afterEach(cleanup);

const tenant = '991825827';

const run = (id: string, version: number, score: number, endedAt: string): EvalRun => ({
  id,
  status: 'completed',
  testSet: 'kjerne',
  version,
  startedAt: endedAt,
  endedAt,
  score,
  passed: Math.round(score * 20),
  total: 20,
});

const runs = [run('r7', 7, 0.9, '2026-11-17T10:00:00Z'), run('r6', 6, 0.8, '2026-11-10T10:00:00Z')];

const cases = [
  {
    case: 'c1',
    input: 'Hvem fører tilsyn med barnehager?',
    type: 'criteria',
    change: 'worse',
    baseline: { pass: true, score: 1 },
    candidate: { pass: false, score: 0, reason: 'Nevner ikke kommunen' },
  },
  {
    case: 'c2',
    input: 'Hva er fristen for klage?',
    type: 'exact',
    change: 'better',
    baseline: { pass: false, score: 0 },
    candidate: { pass: true, score: 1, reason: 'Riktig frist' },
  },
  {
    case: 'c3',
    input: 'Kan du skrive et dikt?',
    type: 'must_reject',
    change: 'same',
    baseline: { pass: true, score: 1 },
    candidate: { pass: true, score: 1, reason: 'Avviste' },
  },
];

const platform = () => {
  const asked: URLSearchParams[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw.replace(/^\/api/, ''), 'http://portal');
    if (url.pathname.endsWith('/eval-runs/compare')) {
      const q = url.searchParams;
      asked.push(q);
      const change = q.get('change') as CaseChange | null;
      const data = cases.filter((c) => !change || c.change === change);
      const side = (id: string, version: number, score: number) => ({
        id,
        status: 'completed',
        version,
        testSetVersion: 1,
        startedAt: '2026-11-10T10:00:00Z',
        endedAt: '2026-11-10T10:05:00Z',
        score,
        passed: Math.round(score * 20),
        cases: 20,
        judges: ['judge:criteria@2+foundry-openai/gpt-4.1'],
      });
      const baseline = q.get('baseline') ?? 'published';
      return new Response(
        JSON.stringify({
          testSet: 'kjerne',
          baseline: {
            ...(baseline === 'r7' ? side('r7', 7, 0.9) : side('r6', 6, 0.8)),
            published: baseline === 'published',
          },
          candidate: side(q.get('candidate') ?? '', 7, 0.9),
          counts: { worse: 1, better: 1, same: 1, new: 0, missing: 0, pending: 0 },
          data,
          total: data.length,
          offset: 0,
          limit: Number(q.get('limit') ?? 50),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ title: 'Not found', status: 404 }), { status: 404 });
  };
  return { asked, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' }) };
};

describe('comparing two versions on Kvalitet', () => {
  it('counts better, same and worse in B and lists the worse cases before the better ones', async () => {
    const { api, asked } = platform();
    render(
      <CompareSection
        api={api}
        tenant={tenant}
        serviceId="rapport"
        runs={runs}
        publishedVersion={6}
      />,
    );

    const section = screen.getByRole('region', { name: 'Sammenlign to versjoner' });
    const items = await within(section).findAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Dårligere«Hvem fører tilsyn med barnehager?» Nevner ikke kommunen',
      'Bedre«Hva er fristen for klage?» Riktig frist',
    ]);
    expect(asked.map((q) => [q.get('candidate'), q.get('baseline'), q.get('change')])).toEqual([
      ['r7', 'r6', 'worse'],
      ['r7', 'r6', 'better'],
    ]);
    expect(within(section).getByText('dårligere i B').previousElementSibling?.textContent).toBe(
      '1',
    );
    expect(within(section).getByText('bedre i B').previousElementSibling?.textContent).toBe('1');
    const a = within(section).getByRole('combobox', { name: 'A' }) as HTMLSelectElement;
    expect(a.selectedOptions[0]?.textContent?.replace(/\s/g, ' ')).toBe('Versjon 6 (i bruk), 80 %');
    expect(within(section).queryByRole('button', { name: /^Bedre/ })).toBeNull();
  });

  it('says the comparison could not be fetched and fetches it again on retry', async () => {
    let failing = true;
    const { api } = platform();
    const flaky = {
      ...api,
      serviceTabs: {
        ...api.serviceTabs,
        compare: (...args: Parameters<typeof api.serviceTabs.compare>) =>
          failing ? Promise.reject(new Error('down')) : api.serviceTabs.compare(...args),
      },
    };
    render(
      <CompareSection
        api={flaky}
        tenant={tenant}
        serviceId="rapport"
        runs={runs}
        publishedVersion={6}
      />,
    );
    expect(await screen.findByText('Klarte ikke å hente sammenligningen.')).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByText(/Hva er fristen for klage\?/)).toBeTruthy();
  });

  it('says a comparison needs two runs of the same test set', () => {
    const { api } = platform();
    render(
      <CompareSection
        api={api}
        tenant={tenant}
        serviceId="rapport"
        runs={runs.slice(0, 1)}
        publishedVersion={7}
      />,
    );

    expect(
      screen.getByText('Du kan sammenligne når testsettet er kjørt minst to ganger.'),
    ).toBeTruthy();
  });
});

describe('the cases of the last run', () => {
  it('shows what each case is checked on and how the earlier version did beside it', async () => {
    const { api, asked } = platform();
    render(
      <CasesSection
        api={api}
        tenant={tenant}
        serviceId="rapport"
        run={runs[0]}
        runs={runs}
        setName="Kjernespørsmål"
      />,
    );

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(asked.at(-1)?.get('baseline')).toBe('r6');
    expect(within(table).getByRole('columnheader', { name: 'Versjon 6' })).toBeTruthy();
    const worse = within(table).getByText('Hvem fører tilsyn med barnehager?').closest('tr');
    expect(
      within(worse as HTMLElement)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    ).toEqual([
      'Hvem fører tilsyn med barnehager?',
      'Kriterier',
      'Feilet',
      'Nevner ikke kommunen',
      'Bestått',
    ]);
    expect(within(table).getByText('Eksakt tekst')).toBeTruthy();
    expect(within(table).getByText('Skal avslå')).toBeTruthy();
    expect(screen.getByText('Versjon 7, testsettet Kjernespørsmål. Feilede først')).toBeTruthy();
  });

  it('filters the cases by result and searches the questions', async () => {
    const { api } = platform();
    render(
      <CasesSection
        api={api}
        tenant={tenant}
        serviceId="rapport"
        run={runs[0]}
        runs={runs}
        setName="Kjernespørsmål"
      />,
    );

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    fireEvent.click(screen.getByRole('button', { name: 'Feilet 1' }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Hvem fører tilsyn med barnehager?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Alle 3' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i sakene' }), {
      target: { value: 'dikt' },
    });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Kan du skrive et dikt?')).toBeTruthy();
  });

  it('says the cases could not be fetched instead of showing the run without a comparison', async () => {
    const { api } = platform();
    let failing = true;
    const flaky = {
      ...api,
      serviceTabs: {
        ...api.serviceTabs,
        compare: (...args: Parameters<typeof api.serviceTabs.compare>) =>
          failing ? Promise.reject(new Error('down')) : api.serviceTabs.compare(...args),
      },
    };
    render(
      <CasesSection
        api={flaky}
        tenant={tenant}
        serviceId="rapport"
        run={runs[0]}
        runs={runs}
        setName="Kjernespørsmål"
      />,
    );
    expect(await screen.findByText('Klarte ikke å hente sakene.')).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByText('Nevner ikke kommunen')).toBeTruthy();
  });
});
