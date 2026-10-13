// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';

document.getAnimations ??= () => [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const platform = () => {
  const calls: { path: string; method: string; reason: string | null; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = url.pathname.replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    calls.push({
      path: `${path}${url.search}`,
      method,
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (path === '/settings')
      return json({
        data: [
          {
            key: 'retrieval.retrieveTopK',
            description: 'Chunks fetched by id after merging.',
            category: 'retrieval',
            axis: 'service',
            sensitivity: 'normal',
            default: 100,
            settableAt: ['platform', 'tenant', 'service', 'call'],
            schema: { type: 'integer', exclusiveMinimum: 0, maximum: 1000 },
          },
        ],
      });
    if (path === '/settings/defaults')
      return json({ data: [{ key: 'retrieval.retrieveTopK', version: 2, value: 80 }] });
    if (path === '/settings/defaults/retrieval.retrieveTopK/changelog')
      return json({
        data: [
          {
            key: 'retrieval.retrieveTopK',
            version: 2,
            value: 80,
            changedAt: '2026-10-01T08:00:00Z',
            changedBy: 'drift',
            reason: 'Færre treff gir raskere svar',
          },
        ],
      });
    if (path === '/settings/defaults/retrieval.retrieveTopK' && method === 'PUT')
      return url.search.includes('dryRun')
        ? json({ dryRun: true, services: [] })
        : json({ task: 't1', value: {} });
    if (path === '/operator/settings/overrides')
      return json({
        tenants: {
          '991825827': { values: { 'retrieval.retrieveTopK': 40 }, pins: {} },
          '999888777': { values: {}, pins: {} },
        },
        services: [
          {
            tenant: '991825827',
            service: 'kunnskapsassistenten',
            version: 3,
            settings: { 'retrieval.retrieveTopK': 20 },
          },
        ],
      });
    if (path === '/operator/tenants') return json({ data: [] });
    if (path === '/health') return json({ status: 'ok', version: 'dev' });
    return new Response('404 Not Found', { status: 404 });
  };
  return { calls, fetch };
};

const open = async (fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Ola Drift', roles: [operatorRole] });
  await auth.login();
  window.location.hash = '#/settings';
  render(<App auth={auth} fetch={fetch} />);
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('live platform settings', () => {
  it('shows the current default, tenant and service values with Norwegian names', async () => {
    await open(platform().fetch);

    const label = await screen.findByRole('button', { name: 'Treff som hentes (top-k)' });
    const row = label.closest('tr') as HTMLElement;
    expect(within(row).getAllByText('20').length).toBeGreaterThan(0);
    expect((screen.getByRole('combobox', { name: 'Virksomhet' }) as HTMLSelectElement).value).toBe(
      '991825827',
    );
    expect(screen.queryByText(/viser bare plattformstandardene/)).toBeNull();
  });

  it('changes a default with a reason and shows the changelog', async () => {
    const { calls, fetch } = platform();
    await open(fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Treff som hentes (top-k)' }));

    expect(await screen.findByText('Færre treff gir raskere svar')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Verdi'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forhåndsvis endring' }));
    await screen.findByText('Lagres i revisjonsloggen.');
    const saved = () =>
      calls.find(
        (c) => c.method === 'PUT' && c.path === '/settings/defaults/retrieval.retrieveTopK',
      );
    await waitFor(() => {
      if (!saved()) {
        fireEvent.change(document.getElementById('grunn') as HTMLElement, {
          target: { value: 'Raskere svar for alle' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
      }
      expect(saved()).toBeTruthy();
    });
    expect(await screen.findByText(/er lagret/)).toBeTruthy();
    const put = calls.find(
      (c) => c.method === 'PUT' && c.path === '/settings/defaults/retrieval.retrieveTopK',
    );
    expect(put?.body).toEqual({ value: 60 });
    expect(put?.reason).toBe('Raskere svar for alle');
  });

  it('edits a house style in a multi-line field and a short text in a single line', async () => {
    const { fetch: base } = platform();
    const text = (max: number) => ({ type: 'string', maxLength: max });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
      if (path === '/settings')
        return json({
          data: ['answers.languageInstructions.nb', 'answers.writtenStandard'].map((key, i) => ({
            key,
            description: key,
            category: 'answers',
            axis: 'service',
            sensitivity: 'normal',
            default: 'Svar på bokmål.',
            settableAt: ['platform', 'tenant', 'service'],
            schema: text(i === 0 ? 4000 : 20),
          })),
        });
      if (path === '/settings/defaults')
        return json({
          data: [{ key: 'answers.languageInstructions.nb', version: 1, value: 'Svar.\nVær kort.' }],
        });
      return base(input, init);
    };
    await open(fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Husstil for svar på bokmål' }));

    const field = await screen.findByLabelText('Verdi');
    expect(field.tagName).toBe('TEXTAREA');
    fireEvent.click(await screen.findByRole('button', { name: 'Målform i svar' }));
    expect((await screen.findByLabelText('Verdi')).tagName).toBe('INPUT');
  });

  it('names the tenants in the impact preview, not their organisation numbers', async () => {
    const { fetch: base } = platform();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/operator/tenants'))
        return json({
          data: [
            { orgNumber: '999888777', name: 'Testetaten', status: 'active', services: 1 },
            { orgNumber: '991825827', name: 'Digdir', status: 'active', services: 1 },
          ],
        });
      if (url.includes('retrieveTopK?dryRun=true'))
        return json({
          dryRun: true,
          services: [
            {
              tenant: '999888777',
              service: 'rapportassistenten',
              version: 2,
              status: 'changes',
              before: 80,
              after: 60,
            },
            {
              tenant: '991825827',
              service: 'kunnskapsassistenten',
              version: 3,
              status: 'overridden',
              before: 20,
              after: 20,
            },
          ],
        });
      return base(input, init);
    };
    await open(fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Treff som hentes (top-k)' }));
    fireEvent.change(screen.getByLabelText('Verdi'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Forhåndsvis endring' }));

    expect(await screen.findByText('rapportassistenten · Testetaten')).toBeTruthy();
    expect(screen.getByText('kunnskapsassistenten · Digdir: 20')).toBeTruthy();
    expect(screen.queryByText(/999888777/)).toBeNull();
  });
});
