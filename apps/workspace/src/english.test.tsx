// @vitest-environment jsdom
import { catalogueProblems, type Locale } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceApi } from './api';
import { failureFromAnswer } from './failures';
import { en, nb } from './i18n';
import { exampleGoalTable, mockWorkspaceApi } from './mock';
import { exampleProject, mockProjectsApi } from './projects-mock';
import { tableFrom, type ResultTable } from './ResultTable';
import { TableResult } from './screens/TableResult';
import { expectAccessible, renderApp, renderInEnglish } from './testing';
import type { WorkspaceApi } from './types';

document.getAnimations ??= () => [];

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('the English catalogue', () => {
  it('translates every bokmål message with the same placeholders and tags', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('recognises the platform refusals in either language', () => {
    expect(failureFromAnswer(en.failures.platformTopic)).toEqual({ kind: 'refused' });
    expect(failureFromAnswer(en.failures.platformSources)).toEqual({ kind: 'no-sources' });
  });
});

describe('the workspace in English', () => {
  it('follows an English browser and marks the page as English', async () => {
    const { container } = await renderInEnglish('');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeTruthy();
    expect(screen.getByText('AI workspace')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Workspace' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Conversation', 'Projects', 'For approval', 'Error messages', 'Document draft']);
    expect(document.documentElement.lang).toBe('en');
    expectAccessible(container, 'en');
  });

  it('switches language from the user menu and saves it for the person', async () => {
    const saved: (Locale | null)[] = [];
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      setLanguage: async (_tenant, value) => {
        saved.push(value);
      },
    };
    await renderApp('#/chat', { api });
    fireEvent.click(screen.getByRole('button', { name: 'Per Hansen, åpne brukermeny' }));
    const menu = screen.getByRole('dialog', { name: 'Brukermeny' });
    const group = within(menu).getByRole('group', { name: 'Språk / Language' });
    expect(within(group).getByRole('radio', { name: 'Som nettleseren' })).toHaveProperty(
      'checked',
      true,
    );

    fireEvent.click(within(group).getByRole('radio', { name: 'English' }));

    expect(await screen.findByText('Your language has been saved.')).toBeTruthy();
    expect(saved).toEqual(['en']);
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('uses the language the person saved earlier', async () => {
    const api: WorkspaceApi = { ...mockWorkspaceApi(), language: async () => 'en' };
    await renderApp('#/chat', { api });
    expect(await screen.findByRole('navigation', { name: 'Workspace' })).toBeTruthy();
  });

  it('labels answers as made with AI and lists their sources', async () => {
    await renderInEnglish('#/chat');
    expect(await screen.findByText(/The answers are made by AI\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How data is processed' })).toBeTruthy();
    const conversation = screen.getByRole('list', { name: 'Conversation' });
    expect(within(conversation).getAllByText('Answer made with AI').length).toBeGreaterThan(0);
    expect(within(conversation).getAllByText('Sources').length).toBeGreaterThan(0);
    expect(
      within(conversation).getAllByRole('group', { name: 'Feedback on the answer' }).length,
    ).toBeGreaterThan(0);
  });

  it('explains a failed answer in plain English', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      chat: async () => ({ text: '', sources: [], failure: { kind: 'quota' } }),
    };
    await renderInEnglish('#/chat', { api, initialMessages: [] });
    fireEvent.change(await screen.findByRole('textbox', { name: /^Still et spørsmål/ }), {
      target: { value: 'What is new?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('The quota is used up')).toBeTruthy();
    expect(screen.getByText(/has used the whole quota for October\./)).toBeTruthy();
  });

  it('lists projects in English', async () => {
    await renderInEnglish('#/projects', { projects: mockProjectsApi() });
    const link = await screen.findByRole('link', { name: exampleProject().name });
    const card = link.closest('li') as HTMLElement;
    expect(within(card).getByText('1 selection')).toBeTruthy();
    expect(within(card).getByText('3 new documents')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
  });

  it('shows the error page in English', async () => {
    await renderInEnglish('#/errors', {
      api: { ...mockWorkspaceApi(), failedRuns: async () => [] },
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Error messages' })).toBeTruthy();
    expect(screen.getByText('None of your runs have failed in the last 30 days.')).toBeTruthy();
  });
});

describe('the table page in English', () => {
  it('marks the draft and counts rows and missing sources', () => {
    render(
      <InLocale locale="en">
        <TableResult
          entry={{
            key: 'task-1',
            task: 'task-1',
            serviceName: 'Goal assessment',
            createdAt: '2026-10-08T08:14:00Z',
            inputs: [],
            table: tableFrom(exampleGoalTable) as ResultTable,
          }}
          actions={{}}
          userName="Per Hansen"
          onFlash={() => undefined}
        />
      </InLocale>,
    );
    expect(screen.getByText(/Draft made with AI\./)).toBeTruthy();
    expect(screen.getByText(/^4 rows: /)).toBeTruthy();
    expect(screen.getByText('1 cell is missing a source')).toBeTruthy();
    expect(screen.getByText('Goal assessment · 8 October 2026, 10:14')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve the table' })).toBeTruthy();
  });
});

describe('the API client', () => {
  it('asks for answers and problem details in the active language', async () => {
    const headers: Record<string, string>[] = [];
    const api = createWorkspaceApi({
      baseUrl: '/api',
      token: () => 't',
      locale: () => 'en',
      fetch: async (_url, init) => {
        headers.push(init?.headers as Record<string, string>);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });
    await api.listServices();
    expect(headers[0]?.['accept-language']).toBe('en');
  });
});
