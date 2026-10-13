// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { localizedEngine } from './api';
import { mockEntra, operatorRole } from './auth';
import { translator } from './i18n';
import { mockFetch } from './mock';
import type { KnowledgeEngine } from './types';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const open = async (path: string, fetch = mockFetch()) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const startSupport = async (tenant = '999888777') => {
  window.location.hash = `#/support-access?tenant=${tenant}`;
  fireEvent.change(await screen.findByRole('textbox', { name: /Begrunnelse/ }), {
    target: { value: 'Kunden melder feil svar, sak DIG-4412' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start støttetilgang' }));
  await screen.findByRole('heading', { name: /^Portalen til / });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('console polish', () => {
  it('asks for a run id when Slå opp is pressed with nothing typed', async () => {
    await open('#/diagnostics?tenant=999888777');
    fireEvent.click(await screen.findByRole('button', { name: 'Slå opp' }));
    expect(await screen.findByText('Skriv ID-en for kjøringen du vil slå opp.')).toBeTruthy();
    expect(screen.queryByText(/krever derfor en støttetilgang/)).toBeNull();
  });

  it('shows diagnostics settings with the Innstillinger labels, not raw keys and enum values', async () => {
    const base = mockFetch();
    const effective = {
      'planner.enabled': {
        key: 'planner.enabled',
        label: 'planner.enabled',
        value: true,
        source: 'default',
        defaultVersion: 3,
        overridden: [],
        rejected: [],
      },
      'planner.expansionMode': {
        key: 'planner.expansionMode',
        value: 'corpus-aware-2hop',
        source: 'service',
        defaultVersion: 3,
        overridden: [{ layer: 'default', value: 'blind' }],
        rejected: [],
      },
    };
    const fetch: typeof globalThis.fetch = async (input, init) =>
      /\/settings\/effective/.test(String(input))
        ? new Response(JSON.stringify(effective), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : base(input, init);
    await open('#/tenants', fetch);
    await screen.findByRole('table');
    await startSupport();
    window.location.hash = '#/diagnostics?tenant=999888777';
    fireEvent.click(await screen.findByRole('radio', { name: 'Tjeneste' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Navn på tjenesten' }), {
      target: { value: 'kunnskapsassistenten' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Slå opp' }));

    const grid = await screen.findByRole('region', { name: 'Innstillinger' });
    const planner = within(grid).getByRole('rowheader', { name: /Planlegg søket/ });
    expect(planner.textContent).toBe('Planlegg søket');
    const mode = within(grid)
      .getByRole('rowheader', { name: /Måte å utvide spørsmålet på/ })
      .closest('tr') as HTMLElement;
    expect(within(mode).getAllByText('Med blikk på innholdet, to steg').length).toBeGreaterThan(0);
    expect(within(grid).queryByText('corpus-aware-2hop')).toBeNull();
  });

  it('keeps the sidebar below the top bar, also when the support banner makes it taller', async () => {
    const offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('top') ? 184 : 0;
      },
    });
    try {
      await open('#/tenants');
      await screen.findByRole('table');
      const shell = document.querySelector('.shell') as HTMLElement;
      await waitFor(() => expect(shell.style.getPropertyValue('--top-height')).toBe('184px'));
    } finally {
      if (offset) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offset);
    }
  });

  it('says next to the System atlas link that the atlas is English only', async () => {
    await open('#/tenants');
    const nav = await screen.findByRole('navigation', { name: /meny/i });
    const atlas = within(nav).getByRole('link', { name: /Systematlas/ });
    expect(atlas.closest('li')?.textContent).toMatch(/Atlaset finnes bare på engelsk\./);
  });

  it('translates the title of the built-in search engine', () => {
    const engine = {
      engine: 'pgvector',
      title: 'Innebygd søk',
      tech: 'Postgres med pgvector',
      builtin: true,
      capabilities: [],
    } as KnowledgeEngine;
    expect(localizedEngine(engine, translator('en')).title).toBe('Built-in search');
    expect(localizedEngine(engine, translator('nb')).title).toBe('Innebygd søk');
    const other = { ...engine, engine: 'typesense', title: 'Typesense' };
    expect(localizedEngine(other, translator('en')).title).toBe('Typesense');
  });
});
