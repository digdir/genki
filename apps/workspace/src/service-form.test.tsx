// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceApi } from './api';
import { exampleGoalTable, mockWorkspaceApi } from './mock';
import { tableFrom, type ResultTable } from './ResultTable';
import { ServiceForm, type FormValues } from './ServiceForm';
import { expectAccessible, renderApp } from './testing';
import type {
  ChatMessage,
  ConversationSummary,
  FormInput,
  ServiceOption,
  WorkspaceApi,
} from './types';

document.getAnimations ??= () => [];

afterEach(cleanup);

const maloppnaelse: ServiceOption = {
  id: 'maloppnaelse__default',
  name: 'Vurdering av måloppnåelse',
  inputFields: [
    {
      id: 'ministry',
      label: 'Departement',
      kind: 'choice',
      required: true,
      options: ['Kunnskapsdepartementet', 'Klima- og miljødepartementet'],
    },
    {
      id: 'agency',
      label: 'Virksomhet',
      kind: 'organisation',
      required: true,
      help: 'Virksomheten som rapporterer',
    },
    { id: 'year', label: 'År', kind: 'year' },
    { id: 'topics', label: 'Tema', kind: 'multi-choice', options: ['Mål', 'Budsjett'] },
  ],
};

const boot = async () => {
  const calls: { history: { role: string; content: string }[]; input?: FormInput }[] = [];
  const api: WorkspaceApi = {
    ...mockWorkspaceApi(),
    listServices: async () => [maloppnaelse],
    chat: async (_service, history, _onDelta, _signal, input) => {
      calls.push({ history, ...(input ? { input } : {}) });
      return { text: 'Målene er i hovedsak nådd.', sources: [] };
    },
  };
  const view = await renderApp('#/chat', { api, initialMessages: [] });
  return { calls, view };
};

describe('a service with an input form in the workspace', () => {
  it('shows the service, the form and marks required fields', async () => {
    const { view } = await boot();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Vurdering av måloppnåelse' }),
    ).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Departement/ })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /Virksomhet/ })).toBeTruthy();
    expect(screen.getAllByText('Må fylles ut')).toHaveLength(2);
    expect(screen.getByRole('group', { name: 'Tema' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: /Noe mer tjenesten bør vite\?/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kjør tjenesten' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expectAccessible(view.container);
  });

  it('lists what is missing in an error summary that links to each field', async () => {
    const { calls, view } = await boot();
    fireEvent.click(await screen.findByRole('button', { name: 'Kjør tjenesten' }));

    expect(await screen.findByText('For å kjøre tjenesten må du rette opp dette:')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fyll ut «Departement».' }).getAttribute('href')).toBe(
      '#skjema-ministry',
    );
    expect(screen.getByRole('link', { name: 'Fyll ut «Virksomhet».' }).getAttribute('href')).toBe(
      '#skjema-agency',
    );
    expect(calls).toEqual([]);
    expectAccessible(view.container);
  });

  it('runs the service with the values, then shows the choices and a follow-up question', async () => {
    const { calls } = await boot();
    fireEvent.change(await screen.findByRole('combobox', { name: /Departement/ }), {
      target: { value: 'Kunnskapsdepartementet' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Virksomhet/ }), {
      target: { value: 'Utdanningsdirektoratet' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'År' }), { target: { value: '2025' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Budsjett' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Noe mer tjenesten bør vite\?/ }), {
      target: { value: 'Se særlig på budsjett.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør tjenesten' }));

    await screen.findByText('Målene er i hovedsak nådd.');
    expect(calls[0]?.input).toEqual({
      ministry: 'Kunnskapsdepartementet',
      agency: 'Utdanningsdirektoratet',
      year: 2025,
      topics: ['Budsjett'],
    });
    expect(calls[0]?.history.at(-1)).toEqual({ role: 'user', content: 'Se særlig på budsjett.' });
    expect(screen.queryByRole('button', { name: 'Kjør tjenesten' })).toBeNull();
    expect(screen.getAllByText('Utdanningsdirektoratet').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Endre valgene' })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Still et oppfølgingsspørsmål' }), {
      target: { value: 'Hvilke mål er ikke nådd?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.history.at(-1)).toEqual({ role: 'user', content: 'Hvilke mål er ikke nådd?' });

    fireEvent.click(screen.getByRole('button', { name: 'Endre valgene' }));
    expect((screen.getByRole('textbox', { name: /Virksomhet/ }) as HTMLInputElement).value).toBe(
      'Utdanningsdirektoratet',
    );
  });

  it('saves a form run like a conversation, so its table and choices come back after a reload and a service switch', async () => {
    const saved: ConversationSummary[] = [];
    const turns: ChatMessage[] = [];
    const renamed: string[] = [];
    const table = tableFrom(exampleGoalTable) as ResultTable;
    const other: ServiceOption = { id: 'rapportassistenten', name: 'Rapportassistenten' };
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [maloppnaelse, other],
      chat: async (_service, history, _onDelta, _signal, input, conversation) => {
        if (conversation && !conversation.id)
          saved.push({ id: 'run-1', title: 'Ny tråd', agentId: 'maloppnaelse', created: '' });
        turns.push(
          { id: 'u', role: 'user', text: history.at(-1)?.content ?? '', lang: 'nb' },
          { id: 'a', role: 'assistant', text: '', lang: 'nb', sources: [], task: 'task-1' },
        );
        expect(input).toMatchObject({ agency: 'Utdanningsdirektoratet' });
        return { text: '', sources: [], table, task: 'task-1', conversationId: 'run-1' };
      },
      conversations: {
        list: async () => saved.map((c) => ({ ...c })),
        messages: async () =>
          turns.map((m): ChatMessage =>
            m.role === 'user'
              ? {
                  ...m,
                  text: 'Departement: Kunnskapsdepartementet\nVirksomhet: Utdanningsdirektoratet',
                }
              : { id: m.id, role: 'assistant', text: '', lang: 'nb', sources: [], task: 'task-1' },
          ),
        rename: async (id, title) => {
          renamed.push(title);
          for (const c of saved) if (c.id === id) c.title = title;
        },
      },
      tableReview: async () => ({
        input: { ministry: 'Kunnskapsdepartementet', agency: 'Utdanningsdirektoratet' },
        table,
        edits: [],
        approval: { status: 'draft' },
      }),
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    fireEvent.change(await screen.findByRole('combobox', { name: /Departement/ }), {
      target: { value: 'Kunnskapsdepartementet' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Virksomhet/ }), {
      target: { value: 'Utdanningsdirektoratet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kjør tjenesten' }));
    await screen.findByRole('button', { name: 'Åpne tabellen med kilder' });
    await waitFor(() =>
      expect(renamed).toEqual(['Kunnskapsdepartementet, Utdanningsdirektoratet']),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Tjeneste' }), {
      target: { value: 'rapportassistenten' },
    });
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tjeneste' }), {
      target: { value: maloppnaelse.id },
    });
    expect(await screen.findByRole('button', { name: 'Åpne tabellen med kilder' })).toBeTruthy();
    cleanup();

    await renderApp('#/chat', { api, initialMessages: [] });
    expect(await screen.findByRole('button', { name: 'Åpne tabellen med kilder' })).toBeTruthy();
    expect(screen.getByText('Virksomhet:').nextElementSibling?.textContent).toBe(
      'Utdanningsdirektoratet',
    );
    expect(screen.queryByRole('button', { name: 'Kjør tjenesten' })).toBeNull();
    fireEvent.click(screen.getByText('Tidligere samtaler'));
    expect(
      screen.getByRole('button', { name: 'Kunnskapsdepartementet, Utdanningsdirektoratet' }),
    ).toBeTruthy();
  });

  it('waits for the field a choice depends on, and starts from the defaults', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [
        {
          id: 'avhengig',
          name: 'Avhengig',
          inputFields: [
            { id: 'ministry', label: 'Departement', kind: 'choice', options: ['A', 'B'] },
            {
              id: 'agency',
              label: 'Virksomhet',
              kind: 'choice',
              options: ['X', 'Y'],
              dependsOn: 'ministry',
            },
            { id: 'year', label: 'År', kind: 'year', default: 2025 },
          ],
        },
      ],
    };
    await renderApp('#/chat', { api, initialMessages: [] });

    const agency = (await screen.findByRole('combobox', {
      name: /Virksomhet/,
    })) as HTMLSelectElement;
    expect(agency.disabled).toBe(true);
    expect(agency.textContent).toContain('Velg departement først');
    expect((screen.getByRole('textbox', { name: 'År' }) as HTMLInputElement).value).toBe('2025');
    fireEvent.change(screen.getByRole('combobox', { name: /Departement/ }), {
      target: { value: 'A' },
    });
    expect(agency.disabled).toBe(false);
  });
});

describe('the workspace API client and input forms', () => {
  it('reads input_fields from /v1/models and sends the form as `input`', async () => {
    const bodies: unknown[] = [];
    const api = createWorkspaceApi({
      baseUrl: '',
      token: () => 'token',
      fetch: async (url, init) => {
        if (String(url).endsWith('/v1/models'))
          return Response.json({
            data: [
              { id: 'maloppnaelse__default', _chat: true, input_fields: maloppnaelse.inputFields },
            ],
          });
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });

    const [service] = await api.listServices();
    await api.chat(
      'maloppnaelse__default',
      [{ role: 'user', content: '' }],
      () => undefined,
      undefined,
      {
        ministry: 'Kunnskapsdepartementet',
      },
    );

    expect(service?.inputFields?.map((f) => f.id)).toEqual([
      'ministry',
      'agency',
      'year',
      'topics',
    ]);
    expect(bodies[0]).toMatchObject({ input: { ministry: 'Kunnskapsdepartementet' } });
  });
});

describe('a field with many options', () => {
  const agencies = Array.from({ length: 300 }, (_, i) => `Virksomhet ${i + 1}`);
  const Harness = ({ seen }: { seen: (string | string[])[] }) => {
    const [values, setValues] = useState<FormValues>({});
    return (
      <ServiceForm
        fields={[
          { id: 'agencies', label: 'Virksomheter', kind: 'multi-choice', options: agencies },
        ]}
        values={values}
        errors={{}}
        onChange={(id, value) => {
          seen.push(value);
          setValues((v) => ({ ...v, [id]: value }));
        }}
      />
    );
  };

  it('offers a searchable list instead of hundreds of checkboxes, and keeps what is chosen', () => {
    const seen: (string | string[])[] = [];
    const { container } = render(<Harness seen={seen} />);

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByLabelText(/Virksomheter/, { selector: 'input' })).toBeTruthy();
    expect(
      [...container.querySelectorAll('u-option')].filter((o) => o.textContent !== 'Ingen treff'),
    ).toHaveLength(300);

    const suggestion = container.querySelector('ds-suggestion') as HTMLElement;
    const pick = (value: string) => {
      const item = document.createElement('data');
      item.value = value;
      item.textContent = value;
      act(() => {
        suggestion.dispatchEvent(
          new CustomEvent('comboboxbeforeselect', { detail: item, cancelable: true }),
        );
      });
    };
    pick('Virksomhet 7');
    pick('Virksomhet 42');

    expect(seen.at(-1)).toEqual(['Virksomhet 7', 'Virksomhet 42']);
    expect(container.querySelectorAll('ds-suggestion > data')).toHaveLength(2);
  });
});
