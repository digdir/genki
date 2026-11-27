// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { inEnglish } from '@genai/i18n/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('organisation access and audit in English', () => {
  it('shows the audit log with English filters and action labels', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T12:00:00+02:00'));
    await open('#/audit');
    expect(await screen.findByRole('heading', { name: 'Log' })).toBeTruthy();
    expect(await screen.findByLabelText('Organisation')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export (CSV)' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Log' })).toBeTruthy();
  });

  it('asks for a reason to see content with English copy and a reason rule', async () => {
    await open('#/diagnostics?tenant=999888777');
    fireEvent.change(await screen.findByRole('textbox', { name: 'Run ID' }), {
      target: { value: 'opg_7f2kq9d1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reason to see content' });
    expect(within(dialog).getByText(/content may contain personal data/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'See content' }));
    expect(
      await within(dialog).findByText(/Write a reason of at least 10 characters/),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Reason/ }), {
      target: { value: 'The customer reports a wrong answer, case DIG-4420' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'See content' }));
    expect(await screen.findByRole('heading', { name: 'opg_7f2kq9d1' })).toBeTruthy();
  });

  it('opens the organisation screen in English without a session to start', async () => {
    await open('#/support-access?tenant=999888777');
    expect(await screen.findByRole('heading', { level: 1, name: 'Organisation' })).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Keys' })).toBeTruthy();
  });

  it('shows the export, import and clone choices on the transfer page', async () => {
    await open('#/settings?tab=transfer');
    expect(await screen.findByText('Import from file')).toBeTruthy();
    expect(screen.getByText('Clone from another organisation')).toBeTruthy();
  });
});
