// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { ServiceNav, ServiceSubNav } from './ServiceNav';

afterEach(cleanup);

const renderNav = () =>
  render(
    <ServiceNav
      id="rapport"
      name="Rapportassistenten"
      sections={['overview', 'setup', 'quality']}
      current="setup"
    />,
  );

const link = (name: string) => screen.getByRole('tab', { name });

describe('the service tab bar', () => {
  it('moves the focus to the next and previous tab with the arrow keys, wrapping at the ends', () => {
    renderNav();
    link('Oppsett').focus();

    fireEvent.keyDown(link('Oppsett'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(link('Kvalitet'));
    fireEvent.keyDown(link('Kvalitet'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(link('Oversikt'));
    fireEvent.keyDown(link('Oversikt'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(link('Kvalitet'));
  });

  it('moves the focus to the first and last tab with Home and End', () => {
    renderNav();
    link('Oppsett').focus();

    fireEvent.keyDown(link('Oppsett'), { key: 'End' });
    expect(document.activeElement).toBe(link('Kvalitet'));
    fireEvent.keyDown(link('Kvalitet'), { key: 'Home' });
    expect(document.activeElement).toBe(link('Oversikt'));
  });

  it('names the tab bar after the service, so its tabs are told apart from the sidebar links', () => {
    renderNav();

    expect(screen.getByRole('tablist', { name: 'Faner for Rapportassistenten' })).toBeTruthy();
    expect(link('Oppsett').getAttribute('aria-selected')).toBe('true');
  });
});

describe('the Utviklerverktøy side menu', () => {
  it('moves the focus between its tabs with the up and down arrow keys', () => {
    render(
      <ServiceSubNav
        id="rapport"
        sections={['versions', 'log', 'channels', 'environments', 'batch', 'definition']}
        current="log"
      />,
    );
    const menu = screen.getByRole('tablist', { name: 'Utviklerverktøy' });
    expect(menu.getAttribute('aria-orientation')).toBe('vertical');
    const tab = (name: string) => screen.getByRole('tab', { name });
    tab('Logg').focus();

    fireEvent.keyDown(tab('Logg'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tab('Nøkler og kanaler'));
    fireEvent.keyDown(tab('Nøkler og kanaler'), { key: 'ArrowUp' });
    fireEvent.keyDown(tab('Logg'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(tab('Versjoner'));
    fireEvent.keyDown(tab('Versjoner'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(tab('Definisjon (YAML)'));
  });

  it('counts versions, runs today, active keys, environments and running jobs, and nothing for YAML', async () => {
    const reply = (path: string): unknown => {
      if (path.includes('/definitions/'))
        return {
          versions: Array.from({ length: 7 }, (_, i) => ({ version: i + 1 })),
          latest: { version: 7 },
        };
      if (path.includes('/tasks')) return { data: [], total: 412, offset: 0, limit: 1 };
      if (path.endsWith('/api-keys'))
        return {
          keys: [
            { id: 'a', revokedAt: null },
            { id: 'b', revokedAt: null },
            { id: 'c', revokedAt: '2026-09-30T08:00:00Z' },
          ],
        };
      if (path.endsWith('/environments'))
        return { latestVersion: 7, environments: [{ name: 'prod' }, { name: 'test' }] };
      if (path.endsWith('/batch-runs'))
        return {
          data: [
            { id: 'r1', status: 'running' },
            { id: 'r2', status: 'succeeded' },
          ],
        };
      return {};
    };
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(reply(url.split('?')[0] ?? '')), {
        headers: { 'content-type': 'application/json' },
      });
    };
    render(
      <ServiceSubNav
        id="rapport"
        sections={['versions', 'log', 'channels', 'environments', 'batch', 'definition']}
        current="log"
        api={createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' })}
        tenant="991825827"
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /^Batch/ }).textContent).toBe('Batch 1 pågår'),
    );
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Versjoner 7',
      'Logg 412 i dag',
      'Nøkler og kanaler 2 aktive',
      'Miljøer 2',
      'Batch 1 pågår',
      'Definisjon (YAML)',
    ]);
    expect(screen.getByRole('tab', { name: /^Logg/ }).getAttribute('aria-selected')).toBe('true');
    expect(
      screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(1);
  });
});
