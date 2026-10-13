import { render, within } from '@testing-library/react';
import { expect } from 'vitest';
import { App, type AppProps } from './App';
import { mockLogin } from './auth';
import { mockProjectsApi } from './projects-mock';
import {
  caseworker,
  exampleConversation,
  exampleDraft,
  mockApprovalsApi,
  mockWorkspaceApi,
} from './mock';

export const fixedNow = () => new Date('2026-10-07T10:00:00Z');

export const renderApp = async (path: string, overrides: Partial<Omit<AppProps, 'auth'>> = {}) => {
  const auth = mockLogin(caseworker);
  await auth.login();
  window.location.hash = path;
  return render(
    <App
      auth={auth}
      api={mockWorkspaceApi()}
      approvals={mockApprovalsApi()}
      draft={exampleDraft}
      projects={mockProjectsApi()}
      initialMessages={exampleConversation}
      now={fixedNow}
      {...overrides}
    />,
  );
};

const namedRoles = ['button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'img', 'group'];

export const renderInEnglish = (path: string, overrides: Partial<Omit<AppProps, 'auth'>> = {}) =>
  renderApp(path, { languages: ['en-GB', 'en'], ...overrides });

export const expectAccessible = (root: HTMLElement, lang = 'nb') => {
  const scope = within(root);
  for (const role of namedRoles) {
    const all = scope.queryAllByRole(role);
    const named = scope.queryAllByRole(role, { name: /\S/ });
    expect(named.length, `every ${role} has an accessible name`).toBe(all.length);
  }
  const ids = [...root.querySelectorAll('[id]')].map((el) => el.id);
  expect(new Set(ids).size, 'ids are unique').toBe(ids.length);
  for (const el of root.querySelectorAll(
    '[aria-labelledby], [aria-describedby], [aria-controls]',
  )) {
    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const id of (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean))
        expect(document.getElementById(id), `${attr} target #${id} exists`).not.toBeNull();
    }
  }
  for (const el of root.querySelectorAll('[aria-invalid="true"]'))
    expect(el.getAttribute('aria-describedby'), 'invalid fields describe their error').toBeTruthy();
  expect(root.querySelector(`[lang="${lang}"]`), `the page is marked as ${lang}`).not.toBeNull();
};
