// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { inEnglish } from '@genai/i18n/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const open = async (hash: string) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = hash;
  render(inEnglish(<App auth={auth} fetch={mockFetch()} />));
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('support access and audit in English', () => {
  it('shows the audit log with English filters and action labels', async () => {
    await open('#/audit');
    expect(await screen.findByRole('heading', { name: 'Audit' })).toBeTruthy();
    expect(screen.getByLabelText('Organisation')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export (CSV)' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Audit log' })).toBeTruthy();
  });

  it('starts support access with English copy and a reason rule', async () => {
    await open('#/support-access?tenant=999888777');
    expect(await screen.findByRole('heading', { name: 'Start support access' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start support access' }));
    expect(await screen.findByText(/Write a reason of at least 10 characters/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/ }), {
      target: { value: 'The customer sees the quota wrongly, case DIG-4420' },
    });
    fireEvent.click(screen.getByRole('radio', { name: '30 minutes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start support access' }));
    expect(await screen.findByRole('tab', { name: 'Keys' })).toBeTruthy();
  });

  it('shows the export, import and clone choices on the transfer page', async () => {
    await open('#/settings?tab=transfer');
    expect(await screen.findByText('Import from file')).toBeTruthy();
    expect(screen.getByText('Clone from another organisation')).toBeTruthy();
  });
});
