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
      return new Response(
        JSON.stringify({
          testSet: { id: 'kjerne', name: 'Kjernespørsmål' },
          baseline: { run: 'r6', version: 6, published: true },
          candidate: { run: q.get('candidate'), version: 7 },
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
  it('filters the compared cases by change and counts better, same and worse', async () => {
    const { api, asked } = platform();
    render(<CompareSection api={api} tenant={tenant} serviceId="rapport" runs={runs} />);

    const section = screen.getByRole('region', { name: 'Sammenlign to versjoner' });
    await waitFor(() =>
      expect(
        within(section).getByText('Hvem fører tilsyn med barnehager?', { exact: false }),
      ).toBeTruthy(),
    );
    expect(asked.at(-1)?.get('candidate')).toBe('r7');
    expect(asked.at(-1)?.get('baseline')).toBe('r6');
    expect(asked.at(-1)?.get('change')).toBe('worse');
    expect(within(section).getByText('dårligere').previousElementSibling?.textContent).toBe('1');

    fireEvent.click(within(section).getByRole('button', { name: /^Bedre/ }));
    await waitFor(() => expect(asked.at(-1)?.get('change')).toBe('better'));
    expect(await within(section).findByText(/Hva er fristen for klage\?/)).toBeTruthy();
    expect(within(section).queryByText(/barnehager/)).toBeNull();
    expect(
      within(section)
        .getByRole('button', { name: /^Bedre/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('says a comparison needs two runs of the same test set', () => {
    const { api } = platform();
    render(
      <CompareSection api={api} tenant={tenant} serviceId="rapport" runs={runs.slice(0, 1)} />,
    );

    expect(
      screen.getByText('Du kan sammenligne når testsettet er kjørt minst to ganger.'),
    ).toBeTruthy();
  });
});

describe('the cases of the last run', () => {
  it('filters the cases by result and searches the questions, with the earlier version beside them', async () => {
    const { api } = platform();
    render(<CasesSection api={api} tenant={tenant} serviceId="rapport" run={runs[0]} />);

    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(within(table).getByRole('columnheader', { name: 'versjon 6' })).toBeTruthy();
    expect(within(table).getByText('Nevner ikke kommunen')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Feilet (1)' }));
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Hvem fører tilsyn med barnehager?')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Alle (3)' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i sakene' }), {
      target: { value: 'dikt' },
    });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Kan du skrive et dikt?')).toBeTruthy();
  });
});
