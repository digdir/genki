// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { DefinitionEditor } from './DefinitionEditor';
import { Versions } from './Versions';

afterEach(cleanup);

const tenant = '991825827';
const definition = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'rapport', name: 'Rapport' },
  spec: {
    purpose: 'Svarer på spørsmål',
    model: { primary: 'aivar/borealis-27b' },
    knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
  },
};

const platform = () => {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^\/api/, '').split('?')[0] ?? '';
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (method !== 'GET')
      writes.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith('/definitions/services/rapport'))
      return json({
        kind: 'Service',
        tenant,
        id: 'rapport',
        latest: { version: 7, definition, files: {} },
        versions: [{ version: 7 }],
      });
    if (path.endsWith('/rapport/draft') && method === 'GET') return json(null);
    if (path.endsWith('/rapport/draft') && method === 'PUT')
      return json({
        revision: 1,
        definition: {},
        files: {},
        at: '2026-11-19T13:02:00Z',
        reason: '',
      });
    if (path === '/definitions/validate') return json({ valid: true });
    return json({ title: 'Not found', status: 404 }, 404);
  };
  return { writes, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' }) };
};

describe('the Definisjon (YAML) page', () => {
  it('says a service that was never published has no definition yet, not that loading failed', async () => {
    const { api } = platform();
    render(<DefinitionEditor api={api} tenant={tenant} serviceId="ny" />);

    expect(await screen.findByRole('heading', { name: 'Ingen definisjon ennå' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Prøv igjen/ })).toBeNull();
  });

  it('says a service that was never published has no versions yet, not that loading failed', async () => {
    const { api } = platform();
    render(<Versions api={api} tenant={tenant} serviceId="ny" />);

    expect(await screen.findByRole('heading', { name: 'Ingen versjoner ennå' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Prøv igjen/ })).toBeNull();
  });

  it('jumps to a key of the definition from Hopp til', async () => {
    const { api } = platform();
    render(<DefinitionEditor api={api} tenant={tenant} serviceId="rapport" />);

    const editor = (await screen.findByLabelText('Definisjonen')) as HTMLTextAreaElement;
    const jump = screen.getByRole('navigation', { name: 'Hopp til' });
    expect(
      within(jump)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['metadata', 'spec.purpose', 'spec.model', 'spec.knowledge']);

    fireEvent.click(within(jump).getByRole('link', { name: 'spec.model' }));
    expect(document.activeElement).toBe(editor);
    const line = editor.value.slice(0, editor.selectionStart).split('\n').length;
    expect(editor.value.split('\n')[line - 1]).toBe('  model:');
  });

  it('saves an edit as the draft Oppsett uses instead of publishing it', async () => {
    const { api, writes } = platform();
    render(<DefinitionEditor api={api} tenant={tenant} serviceId="rapport" />);

    const editor = (await screen.findByLabelText('Definisjonen')) as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: { value: editor.value.replace('Svarer på spørsmål', 'Svarer på flere spørsmål') },
    });

    await waitFor(() => expect(writes.some((w) => w.method === 'PUT')).toBe(true), {
      timeout: 3000,
    });
    const put = writes.find((w) => w.method === 'PUT');
    expect(put?.path).toBe(`/tenants/${tenant}/services/rapport/draft`);
    expect((put?.body as { definition: typeof definition }).definition.spec.purpose).toBe(
      'Svarer på flere spørsmål',
    );
    expect(writes.some((w) => w.path === '/definitions')).toBe(false);
    expect(await screen.findByText('Gyldig.')).toBeTruthy();
  });
});
