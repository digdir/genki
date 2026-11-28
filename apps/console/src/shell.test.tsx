// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { inEnglish } from '@genai/i18n/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { translator } from './i18n';
import { mockFetch } from './mock';
import type { SearchSource } from './search';
import { environmentLabel, Shell } from './Shell';
import { PageTabs } from './page-tabs';
import type { Tenant, TenantDefinition } from './types';

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
  render(<App auth={auth} fetch={mockFetch()} />);
};

const menu = () => screen.getByRole('navigation', { name: 'Konsollmeny' });

const tenant = (orgNumber: string, name: string, services = 1): Tenant => ({
  orgNumber,
  name,
  status: 'active',
  services,
  quotaUsedPercent: 40,
});

const definition = (
  id: string,
  name: string,
  rest: Partial<TenantDefinition> = {},
): TenantDefinition => ({
  kind: 'Service',
  id,
  name,
  latestVersion: 1,
  publishedAt: null,
  publishedBy: null,
  ...rest,
});

const noSearch: SearchSource = { tenants: async () => [], services: async () => [] };

const shellAt = (
  path: string,
  {
    badges = {},
    search = noSearch,
  }: { badges?: Record<string, number>; search?: SearchSource } = {},
) =>
  render(
    <Shell
      session={{ name: 'Lise Dahl', roles: [operatorRole] }}
      onLogout={() => undefined}
      path={path}
      badges={badges}
      search={search}
    >
      <h1>Side</h1>
    </Shell>,
  );

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const linkNames = (list: HTMLElement) =>
  within(list)
    .getAllByRole('link')
    .map((link) => link.querySelector('.item-label')?.textContent);

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('console menu', () => {
  it('shows the eleven drawn items in the groups Arbeid and Plattform', async () => {
    await open('#/tenants');

    const work = within(menu()).getByRole('list', { name: 'Arbeid' });
    const platform = within(menu()).getByRole('list', { name: 'Plattform' });
    expect(linkNames(work)).toEqual(['Til behandling', 'Virksomheter', 'Drift', 'Logg']);
    expect(linkNames(platform)).toEqual([
      'Modeller',
      'Katalog',
      'Delte tjenester',
      'Kvalitet',
      'Funksjonsbrytere',
      'Demoer',
      'Innstillinger',
    ]);
    expect(within(menu()).getAllByRole('link', { current: 'page' })).toHaveLength(1);
    expect(within(menu()).getByRole('link', { name: 'Virksomheter' }).getAttribute('href')).toBe(
      '#/tenants',
    );
  });

  it('marks the parent item current on a page that left the menu and offers its sibling pages', async () => {
    await open('#/quality-matrix');

    expect(
      within(menu()).getByRole('link', { name: 'Kvalitet' }).getAttribute('aria-current'),
    ).toBe('page');
    const pages = await screen.findByRole('navigation', { name: 'Sider i Kvalitet' });
    expect(
      within(pages)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Oversikt', 'Matrise', 'Krav og sikkerhetsregler', 'Sporing']);
    expect(within(pages).getByRole('link', { name: 'Matrise' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(pages).getByRole('link', { name: 'Sporing' }).getAttribute('href')).toBe(
      '#/tracing',
    );
  });

  it('offers the connections list as a Modeller tab and marks it current there', async () => {
    await open('#/models?tab=connections');

    const pages = await screen.findByRole('navigation', { name: 'Sider i Modeller' });
    const tab = within(pages).getByRole('link', { name: 'Tilkoblinger' });
    expect(tab.getAttribute('href')).toBe('#/models?tab=connections');
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(
      within(pages).getByRole('link', { name: 'Modeller' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('puts the page tabs under the page heading', async () => {
    await open('#/quality');

    const pages = await screen.findByRole('navigation', { name: 'Sider i Kvalitet' });
    const heading = screen.getByRole('heading', { level: 1, name: 'Kvalitet' });
    expect(heading.compareDocumentPosition(pages) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps an organisation page under Virksomheter without sibling tabs', async () => {
    await open('#/support-access?tenant=974222333');

    expect(
      within(menu()).getByRole('link', { name: 'Virksomheter' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByRole('navigation', { name: 'Sider i Virksomheter' })).toBeNull();
  });

  it('counts what waits in the queue and the quota requests on Til behandling', async () => {
    await open('#/tenants');

    const queue = await within(menu()).findByRole('link', { name: /^Til behandling, \d+ venter$/ });
    expect(queue.getAttribute('href')).toBe('#/queue');
  });
});

describe('menu routes', () => {
  it.each([
    ['/diagnostics', 'Drift'],
    ['/platform-defaults', 'Innstillinger'],
    ['/tenants/services', 'Virksomheter'],
    ['/catalog', 'Modeller'],
    ['/platform-secrets', 'Innstillinger'],
    ['/onboarding', 'Virksomheter'],
  ])('marks the item that holds %s as current', (path, item) => {
    shellAt(path);

    expect(within(menu()).getByRole('link', { current: 'page' }).textContent).toBe(item);
  });

  it('marks no item on a page reached from the user menu', () => {
    shellAt('/schemas');

    expect(within(menu()).queryByRole('link', { current: 'page' })).toBeNull();
  });

  it('adds the quota requests to the queue on the Til behandling badge and hides it at zero', () => {
    shellAt('/tenants', { badges: { queue: 2, quotaRequests: 1 } });
    expect(within(menu()).getByRole('link', { name: 'Til behandling, 3 venter' })).toBeTruthy();
    cleanup();

    shellAt('/tenants', { badges: { queue: 0, quotaRequests: 0 } });
    expect(within(menu()).getByRole('link', { name: 'Til behandling' })).toBeTruthy();
  });

  it('opens and closes the menu at phone width with the Meny button, and closes it on a new page', () => {
    const { rerender } = shellAt('/tenants');
    const toggle = screen.getByRole('button', { name: 'Meny' });

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(menu().parentElement?.classList.contains('open')).toBe(true);
    rerender(
      <Shell
        session={{ name: 'Lise Dahl', roles: [operatorRole] }}
        onLogout={() => undefined}
        path="/audit"
        search={noSearch}
      >
        <h1>Side</h1>
      </Shell>,
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(menu().parentElement?.classList.contains('open')).toBe(false);
  });
});

describe('environment label', () => {
  const t = translator('nb');

  it.each([
    ['test', false, 'Testplattform'],
    ['TEST', false, 'Testplattform'],
    ['prod', false, 'Produksjon'],
    ['production', false, 'Produksjon'],
    ['staging', false, 'staging'],
    [undefined, true, 'Lokalt'],
    [undefined, false, 'Produksjon'],
  ])('shows %s (dev %s) as %s', (configured, dev, label) => {
    expect(environmentLabel(configured, dev, t)).toBe(label);
  });
});

describe('user menu', () => {
  it('lists language, schemas, the atlas and log out, and closes with Escape back on its button', async () => {
    await open('#/tenants');

    const button = screen.getByRole('button', { name: 'Brukermeny for Lise Dahl' });
    fireEvent.click(button);
    const list = screen.getByRole('menu', { name: 'Brukermeny' });
    expect(
      within(list)
        .getAllByRole('menuitem')
        .map((m) => m.childNodes[0]?.textContent),
    ).toEqual(['Språk / Language', 'Skjemaer', 'Systematlas', 'Logg ut']);
    expect(document.activeElement?.textContent).toBe('Språk / Language');
    expect(within(list).getByRole('menuitem', { name: 'Skjemaer' }).getAttribute('href')).toBe(
      '#/schemas',
    );
    fireEvent.keyDown(list, { key: 'Escape' });

    expect(screen.queryByRole('menu', { name: 'Brukermeny' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('opens the language choice from the user menu', async () => {
    await open('#/tenants');

    fireEvent.click(screen.getByRole('button', { name: 'Brukermeny for Lise Dahl' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Språk / Language' }));

    const dialog = screen.getByRole('dialog', { name: 'Språk / Language' });
    expect(within(dialog).getByRole('radio', { name: 'English' })).toBeTruthy();
  });
});

describe('search', () => {
  it('opens with Ctrl+K and finds an organisation that Enter opens', async () => {
    await open('#/tenants');
    await screen.findByRole('table');

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Søk' });
    const field = within(dialog).getByRole('combobox', {
      name: 'Søk etter virksomhet, tjeneste eller handling',
    });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: 'eksempeldir' } });

    const tenants = await within(dialog).findByRole('group', { name: 'Virksomheter' });
    const hit = within(tenants).getByRole('option', { name: /Eksempeldirektoratet/ });
    expect(hit.getAttribute('aria-selected')).toBe('true');
    expect(hit.textContent).toMatch(/974 222 333 · \d+ % av kvoten/);
    expect(
      within(dialog).getByRole('option', { name: 'Endre grenser for Eksempeldirektoratet' }),
    ).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() => expect(window.location.hash).toBe('#/tenants/services?tenant=974222333'));
    expect(screen.queryByRole('dialog', { name: 'Søk' })).toBeNull();
  });

  it('opens with Cmd+K, finds a service by name and moves with the arrow keys', async () => {
    await open('#/tenants');

    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Søk' });
    const field = within(dialog).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'postsort' } });

    const services = await within(dialog).findByRole('group', { name: 'Tjenester' });
    const hit = within(services).getByRole('option', { name: /Postsortering/ });
    expect(hit.getAttribute('aria-selected')).toBe('true');
    expect(field.getAttribute('aria-activedescendant')).toBe(hit.id);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(hit.getAttribute('aria-selected')).toBe('true');
  });

  it('says so when nothing matches, and closes with Escape', async () => {
    await open('#/tenants');

    fireEvent.click(screen.getByRole('button', { name: /Søk etter virksomhet eller tjeneste/ }));
    const dialog = screen.getByRole('dialog', { name: 'Søk' });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'finnes ikke' } });

    expect(await within(dialog).findByText('Ingen treff for «finnes ikke»')).toBeTruthy();
    fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Søk' })).toBeNull();
  });
});

describe('search index', () => {
  const source = () => {
    const services = deferred<TenantDefinition[]>();
    const calls: string[] = [];
    const search: SearchSource = {
      tenants: async () => [
        tenant('111111111', 'Alfa etat'),
        tenant('222222222', 'Beta etat'),
        tenant('333333333', 'Tom etat', 0),
      ],
      services: (org) => {
        calls.push(org);
        if (org === '111111111') return services.promise;
        return Promise.reject(new Error('nede'));
      },
    };
    return { search, services, calls };
  };

  const openSearch = () => {
    fireEvent.click(screen.getByRole('button', { name: /Søk etter virksomhet eller tjeneste/ }));
    return screen.getByRole('dialog', { name: 'Søk' });
  };

  it('says it is still fetching until every organisation has answered, then that nothing matched', async () => {
    const { search, services } = source();
    shellAt('/tenants', { search });
    const dialog = openSearch();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'ingenting' } });

    expect(await within(dialog).findByText('Henter virksomheter og tjenester')).toBeTruthy();
    await act(async () => services.resolve([]));
    expect(await within(dialog).findByText('Ingen treff for «ingenting»')).toBeTruthy();
  });

  it('indexes published services only from organisations that have any, and skips one that fails', async () => {
    const { search, services, calls } = source();
    shellAt('/tenants', { search });
    const dialog = openSearch();
    await act(async () =>
      services.resolve([
        definition('svar', 'Svar på brev'),
        definition('gammel', 'Svar fra arkivet', { state: 'archived' }),
        definition('flyt', 'Svar i flyt', { kind: 'StepFlow' }),
      ]),
    );
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'svar' } });

    const group = await within(dialog).findByRole('group', { name: 'Tjenester' });
    expect(
      within(group)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Svar på brevAlfa etat']);
    expect(calls).toEqual(['111111111', '222222222']);
    fireEvent.click(within(group).getByRole('option'));
    expect(window.location.hash).toBe('#/tenants/services?tenant=111111111&kind=service&id=svar');
  });

  it('says the organisations could not be fetched when the list fails', async () => {
    shellAt('/tenants', {
      search: { tenants: () => Promise.reject(new Error('nede')), services: async () => [] },
    });
    const dialog = openSearch();
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'alfa' } });

    expect(
      await within(dialog).findByText('Kunne ikke hente virksomhetene. Lukk søket og prøv igjen.'),
    ).toBeTruthy();
  });

  it('moves the choice down and wraps up with the arrow keys', async () => {
    const { search, services } = source();
    shellAt('/tenants', { search });
    const dialog = openSearch();
    await act(async () => services.resolve([]));
    const field = within(dialog).getByRole('combobox');
    fireEvent.change(field, { target: { value: 'etat' } });
    await within(dialog).findByRole('group', { name: 'Virksomheter' });
    const options = within(dialog).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))[0]).toBe('true');

    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(field.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(options.at(-1)?.getAttribute('aria-selected')).toBe('true');
  });

  it('gives focus back to where it was and keeps Escape from reaching a panel below', async () => {
    shellAt('/tenants');
    const panelEscape = vi.fn();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') panelEscape();
    };
    window.addEventListener('keydown', onKey);
    try {
      const trigger = screen.getByRole('button', { name: /Søk etter virksomhet eller tjeneste/ });
      trigger.focus();
      const dialog = openSearch();
      fireEvent.keyDown(within(dialog).getByRole('combobox'), { key: 'Escape' });

      expect(screen.queryByRole('dialog', { name: 'Søk' })).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(panelEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });
});

describe('in English', () => {
  it('labels the user menu, the search and the page tabs in English', () => {
    render(
      inEnglish(
        <Shell
          session={{ name: 'Lise Dahl', roles: [operatorRole] }}
          onLogout={() => undefined}
          path="/quality"
          search={noSearch}
        >
          <h1>Page</h1>
          <PageTabs />
        </Shell>,
      ),
    );

    expect(screen.getByRole('list', { name: 'Work' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Pages in Quality' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'User menu for Lise Dahl' }));
    expect(
      within(screen.getByRole('menu', { name: 'User menu' }))
        .getAllByRole('menuitem')
        .map((m) => m.childNodes[0]?.textContent),
    ).toEqual(['Språk / Language', 'Schemas', 'System atlas', 'Sign out']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Search for an organisation or service/ }));
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeTruthy();
  });
});

describe('theme', () => {
  const css = readFileSync(`${import.meta.dirname}/app.css`, 'utf8');

  it('follows the system colour scheme instead of forcing light', () => {
    const html = readFileSync(`${import.meta.dirname}/../index.html`, 'utf8');
    const root = new DOMParser().parseFromString(html, 'text/html').documentElement;

    expect(root.getAttribute('data-color-scheme')).toBe('auto');
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*\[data-color-scheme='auto'\] \.frame \{/,
    );
  });

  it('takes every colour in the frame from the design tokens', () => {
    const frame = css.slice(css.indexOf('.frame {'), css.indexOf('.page-header {'));

    expect(frame.length).toBeGreaterThan(1000);
    expect(frame).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i);
  });
});
