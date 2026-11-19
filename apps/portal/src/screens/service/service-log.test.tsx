// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { LogSection } from './LogSection';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const tenant = '991825827';
const now = () => new Date('2026-11-17T15:00:00+01:00');

const row = (n: number) => ({
  id: `t${n}`,
  status: n % 10 === 0 ? 'failed' : 'completed',
  service: 'rapport',
  capability: 'rapport',
  excerpt: `Spørsmål ${n}`,
  environment: 'prod',
  actor:
    n % 2
      ? { kind: 'person', id: 'employee:mock:ingrid', name: 'Ingrid Berg' }
      : { kind: 'api-key', id: 'api-key:skey-sak', name: 'Saksbehandling' },
  channel: n % 2 ? 'api' : 'api-key',
  createdAt: '2026-11-17T10:00:00Z',
  endedAt: '2026-11-17T10:00:02Z',
  ...(n % 10 === 0
    ? { failure: { code: 'deadline_exceeded', reason: 'Modellen svarte ikke' } }
    : {}),
});

const platform = () => {
  const asked: URLSearchParams[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw.replace(/^\/api/, ''), 'http://portal');
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.pathname.endsWith('/tasks')) {
      const q = url.searchParams;
      asked.push(q);
      const all = Array.from({ length: 60 }, (_, i) => row(i + 1)).filter(
        (r) =>
          (!q.get('q') || r.excerpt.includes(q.get('q') ?? '')) &&
          (!q.get('status') || r.status === q.get('status')) &&
          (!q.get('actor') ||
            r.actor.id === q.get('actor') ||
            (q.get('actor') === 'me' && r.actor.id === 'employee:mock:ingrid')),
      );
      const offset = Number(q.get('offset') ?? 0);
      const limit = Number(q.get('limit') ?? 25);
      return reply({
        data: all.slice(offset, offset + limit),
        total: all.length,
        offset,
        limit,
        ...(q.get('q') ? { q: q.get('q'), searched: 60 } : {}),
      });
    }
    return new Response(JSON.stringify({ title: 'Not found', status: 404 }), { status: 404 });
  };
  return { asked, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' }) };
};

describe('the Logg page of a service', () => {
  it('searches the runs on the server and pages through the result', async () => {
    const { api, asked } = platform();
    render(<LogSection api={api} tenant={tenant} id="rapport" runId={undefined} live now={now} />);

    expect(await screen.findByText('1 til 25 av 60 kjøringer i dag. 6 feilet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(await screen.findByText(/^26 til 50 av 60 kjøringer i dag\./)).toBeTruthy();
    expect(asked.at(-1)?.get('offset')).toBe('25');

    fireEvent.change(screen.getByLabelText('Søk i spørsmål'), { target: { value: 'Spørsmål 5' } });
    await waitFor(() => expect(asked.at(-1)?.get('q')).toBe('Spørsmål 5'));
    expect(asked.at(-1)?.get('offset')).toBe('0');
    expect(
      await screen.findByText(/1 til 11 av 11 kjøringer i dag\..*\(søkte i 60 kjøringer\)/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Spørsmål 50' }).getAttribute('href')).toBe(
      '#/services/rapport/log/t50',
    );
    expect(screen.getByText('Modellen svarte ikke')).toBeTruthy();
  });

  it('asks for a larger page when the reader picks more rows per page', async () => {
    const { api, asked } = platform();
    render(<LogSection api={api} tenant={tenant} id="rapport" runId={undefined} live now={now} />);

    await screen.findByText(/^1 til 25 av 60 /);
    fireEvent.change(screen.getByLabelText('Per side'), { target: { value: '50' } });
    expect(await screen.findByText(/^1 til 50 av 60 /)).toBeTruthy();
    expect(asked.at(-1)?.get('limit')).toBe('50');
  });

  it('opens with the failed runs of today when Oversikt links to them, and resets the filters', async () => {
    window.location.hash = '#/services/rapport/log?status=failed&period=today';
    const { api, asked } = platform();
    render(<LogSection api={api} tenant={tenant} id="rapport" runId={undefined} live now={now} />);

    await waitFor(() => expect(asked.at(-1)?.get('status')).toBe('failed'));
    expect(asked.at(-1)?.get('from')).toBe(new Date(2026, 10, 17).toISOString());
    const filters = screen.getByText('Filtre:').parentElement as HTMLElement;
    expect(within(filters).getByText('I dag')).toBeTruthy();
    expect(within(filters).getByText('Feilet')).toBeTruthy();

    fireEvent.click(within(filters).getByRole('button', { name: 'Nullstill' }));
    const page = () => asked.filter((q) => q.get('limit') !== '1').at(-1);
    await waitFor(() => expect(page()?.get('status')).toBeNull());
    expect(page()?.get('from')).toBeNull();
  });

  it('filters the log to my own runs with Fra', async () => {
    const { api, asked } = platform();
    render(<LogSection api={api} tenant={tenant} id="rapport" runId={undefined} live now={now} />);

    await screen.findByText(/^1 til 25 av 60 /);
    fireEvent.change(screen.getByLabelText('Fra'), { target: { value: 'me' } });
    await waitFor(() => expect(asked.at(-1)?.get('actor')).toBe('me'));
    expect(await screen.findByText(/^1 til 25 av 30 /)).toBeTruthy();
    const filters = screen.getByText('Filtre:').parentElement as HTMLElement;
    expect(within(filters).getByText('Meg')).toBeTruthy();
  });

  it('filters the log by a person or key seen in the runs', async () => {
    const { api, asked } = platform();
    render(<LogSection api={api} tenant={tenant} id="rapport" runId={undefined} live now={now} />);

    await screen.findByText(/^1 til 25 av 60 /);
    const from = screen.getByLabelText('Fra');
    expect(
      within(from)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Alle brukerflater og nøkler', 'Meg', 'Ingrid Berg', 'Nøkkel: Saksbehandling']);
    fireEvent.change(from, { target: { value: 'api-key:skey-sak' } });
    await waitFor(() => expect(asked.at(-1)?.get('actor')).toBe('api-key:skey-sak'));
    expect(await screen.findByText(/^1 til 25 av 30 /)).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('Ingrid Berg')).toBeNull();
    expect(screen.getAllByText('Nøkkel: Saksbehandling').length).toBeGreaterThan(1);
  });
});
