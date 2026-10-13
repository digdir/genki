// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceApi } from './api';
import { mockWorkspaceApi } from './mock';
import { expectAccessible, renderApp } from './testing';
import type { AttachedDocument, ServiceOption, WorkspaceApi } from './types';

document.getAnimations ??= () => [];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const rules = { accepts: ['text/plain', 'text/markdown'], maxBytes: 2 * 1024 * 1024, maxCount: 2 };

const brev: ServiceOption = { id: 'brevhjelp', name: 'Brevhjelp', documents: rules };

const boot = async (service: ServiceOption = brev) => {
  const sent: (AttachedDocument[] | undefined)[] = [];
  const api: WorkspaceApi = {
    ...mockWorkspaceApi(),
    listServices: async () => [service],
    chat: async (_s, _h, _d, _signal, _input, _conversation, documents) => {
      sent.push(documents);
      return { text: 'Fristen er 1. mars.', sources: [] };
    },
  };
  const view = await renderApp('#/chat', { api, initialMessages: [] });
  return { sent, view };
};

const attach = (files: File[]) =>
  fireEvent.change(screen.getByLabelText(/Legg ved filer/), { target: { files } });

describe('documents attached to a question in the workspace', () => {
  it('lets an employee attach a text file to a service that takes documents and sends it with the question', async () => {
    const { sent, view } = await boot();
    await screen.findByText(
      /Tekstfiler \(\.txt, \.md og \.markdown\), inntil 2 MB per fil og 2 filer/,
    );
    attach([new File(['Fristen er 1. mars.'], 'brev.md', { type: '' })]);
    const list = await screen.findByRole('list', { name: 'Vedlagte filer' });
    expect(within(list).getByRole('button', { name: 'Fjern brev.md' })).toBeTruthy();
    expectAccessible(view.container);

    fireEvent.change(screen.getByRole('textbox', { name: 'Still et spørsmål' }), {
      target: { value: 'Hva er fristen?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Fristen er 1. mars.', { selector: 'p' });

    expect(sent[0]).toEqual([
      { name: 'brev.md', mediaType: 'text/markdown', data: btoa('Fristen er 1. mars.') },
    ]);
  });

  it('refuses a file the service cannot read, one that is too large, and too many files', async () => {
    await boot({ ...brev, documents: { ...rules, maxBytes: 10 } });
    await screen.findByLabelText(/Legg ved filer/);

    attach([new File(['%PDF'], 'brev.pdf', { type: 'application/pdf' })]);
    expect(
      await screen.findByText('Tjenesten kan ikke lese brev.pdf. Velg en tekstfil.'),
    ).toBeTruthy();
    attach([new File(['x'.repeat(11)], 'lang.txt', { type: 'text/plain' })]);
    expect(await screen.findByText(/^lang\.txt er for stor\. Grensen er 10/)).toBeTruthy();
    attach(['a', 'b', 'c'].map((n) => new File(['x'], `${n}.txt`, { type: 'text/plain' })));
    expect(await screen.findByText('Du kan legge ved inntil 2 filer.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Vedlagte filer' })).toBeNull();
  });

  it('offers no file picker for a service that does not take documents', async () => {
    await boot({ id: 'klarsprak', name: 'Klarspråk' });
    await screen.findByRole('textbox', { name: 'Still et spørsmål' });
    expect(screen.queryByLabelText(/Legg ved filer/)).toBeNull();
  });

  it('reads the document rules from /v1/models and sends documents as genai_documents', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/v1/models'))
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'brevhjelp',
                _chat: true,
                _documents: { accepts: ['text/plain'], max_bytes: 100, max_count: 1 },
              },
            ],
          }),
        );
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const api = createWorkspaceApi({ baseUrl: '/api', fetch: fetcher, token: () => 'tok' });

    const [service] = await api.listServices();
    await api.chat(
      'brevhjelp',
      [{ role: 'user', content: 'Hva?' }],
      () => undefined,
      undefined,
      undefined,
      undefined,
      [{ name: 'a.txt', mediaType: 'text/plain', data: 'eA==' }],
    );

    expect(service?.documents).toEqual({ accepts: ['text/plain'], maxBytes: 100, maxCount: 1 });
    await waitFor(() =>
      expect(bodies[0]?.genai_documents).toEqual([
        { name: 'a.txt', media_type: 'text/plain', data: 'eA==' },
      ]),
    );
  });
});
