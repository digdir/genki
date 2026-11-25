// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceHeader } from './ServiceHeader';
import {
  editionOf,
  editionPath,
  editionView,
  historyHasOwnTab,
  serviceTabs,
  switchPaths,
  tabOf,
  availableSections,
} from './sections';

afterEach(cleanup);

const header = (view: 'test' | 'inUse' | 'both' | 'shared') =>
  render(
    <ServiceHeader
      name="Kunnskapsassistenten"
      view={view}
      switchHrefs={switchPaths('ka', 'setup')}
      status="Status"
      flash=""
      actions={null}
    />,
  );

describe('the test edition and in use in the service header', () => {
  it('marks the edition on screen as the current page in the switch', () => {
    header('inUse');
    const nav = screen.getByRole('navigation', { name: 'Testutgave eller i bruk' });
    expect(within(nav).getByRole('link', { name: 'I bruk' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: 'Testutgave' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('hides the switch on a page whose rows belong to both', () => {
    header('both');
    expect(screen.queryByRole('navigation', { name: 'Testutgave eller i bruk' })).toBeNull();
    expect(screen.getByText('Status')).toBeTruthy();
  });

  it('hides the switch on a page that applies to both at once', () => {
    header('shared');
    expect(screen.queryByRole('navigation', { name: 'Testutgave eller i bruk' })).toBeNull();
  });

  it('opens the in use edition of the same tab, and the test edition without a query', () => {
    expect(switchPaths('ka', 'setup')).toEqual({
      test: '/services/ka/setup',
      inUse: '/services/ka/setup?edition=in-use',
    });
  });

  it('reads the in use edition from the query and the test edition otherwise', () => {
    expect(editionOf(new URLSearchParams('edition=in-use'))).toBe('inUse');
    expect(editionOf(new URLSearchParams(''))).toBe('test');
  });

  it('shows Teknisk as both editions and Historikk as in use whatever the switch says', () => {
    expect(editionView('log', 'inUse')).toBe('both');
    expect(editionView('versions', 'test')).toBe('inUse');
    expect(editionView('interface', 'inUse')).toBe('inUse');
  });

  it('keeps the in use edition only on tabs that have both editions', () => {
    expect(editionPath('ka', 'quality', 'inUse')).toBe('/services/ka/quality?edition=in-use');
    expect(editionPath('ka', 'log', 'inUse')).toBe('/services/ka/log');
  });

  it('sends the switch from Historikk to the test edition of Oversikt', () => {
    expect(switchPaths('ka', 'versions').test).toBe('/services/ka');
  });

  it('gives Historikk its own tab while the flag says so', () => {
    const tabs = serviceTabs(availableSections({ isNew: false })).map((t) => t.tab);
    expect(historyHasOwnTab).toBe(true);
    expect(tabs).toEqual(['overview', 'setup', 'interface', 'quality', 'history', 'developer']);
    expect(tabOf('versions')).toBe('history');
  });
});
