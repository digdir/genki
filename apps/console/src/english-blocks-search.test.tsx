// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { mockFetch } from './mock';
import { BuildingBlocks } from './screens/BuildingBlocks';
import { SearchEngines } from './screens/SearchEngines';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const api = () => createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'token' });

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('search engines in English', () => {
  it('lists endpoints with English headings, capabilities and status', async () => {
    render(inEnglish(<SearchEngines api={api()} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Search engines' })).toBeTruthy();
    const table = screen.getByRole('region', { name: 'Endpoints' });
    const row = within(table).getByRole('link', { name: 'typesense-digdir' }).closest('tr');
    expect(row?.textContent).toContain('6 of 7: no reading passages in order');
    expect(row?.textContent).toContain('Data in Norway');
    expect(row?.textContent).toContain('23 datasets');
    expect(within(row as HTMLElement).getByText('In operation')).toBeTruthy();
  });

  it('validates the editor in English', async () => {
    render(inEnglish(<SearchEngines api={api()} />));
    fireEvent.click(await screen.findByRole('button', { name: 'New endpoint' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save the endpoint' }));
    expect(await screen.findByText('Correct these fields before you save')).toBeTruthy();
    expect(screen.getAllByText(/Enter a name\./).length).toBeGreaterThan(0);
  });
});

describe('building blocks in English', () => {
  it('groups the registry with English labels', async () => {
    render(inEnglish(<BuildingBlocks api={api()} />));
    expect(await screen.findByRole('heading', { level: 1, name: 'Building blocks' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Failed' })).toBeTruthy();
    expect(screen.getByText('Register an external building block')).toBeTruthy();
  });

  it('previews a new version in English and asks for a reason', async () => {
    render(inEnglish(<BuildingBlocks api={api()} initial="borealis" />));
    fireEvent.click(await screen.findByRole('button', { name: 'Make 2.2 available' }));
    expect(screen.getByText(/No service switches version on its own/)).toBeTruthy();
    const confirm = screen
      .getAllByRole('button', { name: 'Make 2.2 available' })
      .at(-1) as HTMLElement;
    fireEvent.click(confirm);
    expect(await screen.findByText('Write a reason of at least 10 characters.')).toBeTruthy();
  });
});
