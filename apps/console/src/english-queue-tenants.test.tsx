// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe('console in English', () => {
  it('shows the queue with English headings, columns and decision dialog', async () => {
    await open('#/queue');

    expect(await screen.findByRole('heading', { name: 'For processing' })).toBeTruthy();
    const table = (await screen.findAllByRole('region', { name: /^Waiting \(/ }))[0] as HTMLElement;
    expect(within(table).getByRole('columnheader', { name: 'Request' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: 'Sent by' })).toBeTruthy();
    expect(screen.getAllByRole('region', { name: 'Handled' }).length).toBeGreaterThan(0);

    const first = within(table).getAllByRole('button')[0] as HTMLElement;
    fireEvent.click(first);
    const panel = await screen.findByRole('dialog');
    fireEvent.click(within(panel).getByRole('button', { name: /^(Approve|Set under review)$/ }));
    expect(await screen.findByLabelText('Reason')).toBeTruthy();
  });

  it('shows organisations with English table headings and actions', async () => {
    await open('#/tenants');

    expect(await screen.findByRole('heading', { name: 'Organisations' })).toBeTruthy();
    const table = await screen.findByRole('region', { name: 'Organisations' });
    expect(within(table).getByRole('columnheader', { name: 'Services' })).toBeTruthy();
    expect(
      within(table).getAllByRole('button', { name: /^Support access to / }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('navigation', { name: 'Console menu' })).toBeTruthy();
  });

  it('shows onboarding in English', async () => {
    await open('#/onboarding');

    expect(await screen.findByRole('heading', { name: 'Onboarding' })).toBeTruthy();
    expect(await screen.findAllByText('Registered')).not.toHaveLength(0);
  });
});
