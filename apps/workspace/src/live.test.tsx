// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockLogin } from './auth';
import { caseworker } from './mock';
import type { WorkspaceApi } from './types';

document.getAnimations ??= () => [];

const liveApi: WorkspaceApi = {
  listServices: async () => [{ id: 'svar', name: 'svar' }],
  chat: async () => ({ text: '', sources: [] }),
  sendFeedback: async () => undefined,
};

const renderLive = async (path: string) => {
  const auth = mockLogin(caseworker);
  await auth.login();
  window.location.hash = path;
  return render(<App auth={auth} api={liveApi} />);
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('live mode without example data', () => {
  it('starts the chat empty', async () => {
    await renderLive('#/chat');
    await screen.findByRole('textbox', { name: 'Still et spørsmål' });
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText(/Rapportassistenten/)).toBeNull();
  });

  it.each(['#/document', '#/approvals', '#/errors'])(
    'hides views that have nothing behind them and opens the chat for %s',
    async (path) => {
      await renderLive(path);
      await screen.findByRole('textbox', { name: 'Still et spørsmål' });
      expect(
        within(screen.getByRole('navigation', { name: 'Arbeidsflaten' }))
          .getAllByRole('link')
          .map((t) => t.textContent),
      ).toEqual(['Samtale']);
    },
  );
});
