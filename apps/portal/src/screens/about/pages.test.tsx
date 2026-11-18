// @vitest-environment jsdom
import { blockById, caseById, componentById, componentsFor, malbilde } from '@genai/docs-content';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch } from '../../mock';
import { expectAccessible, kari } from '../../test-utils';

const open = (hash: string, languages?: readonly string[]) => {
  window.location.hash = hash;
  return render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} languages={languages} />);
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
});
afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

const defined = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing content');
  return value;
};

const pages = [
  ['#/about', 'Genki: generativ KI for offentlige virksomheter'],
  ['#/about/target-picture', malbilde.title],
  ['#/about/building-blocks', 'Byggeklosser'],
  ['#/about/building-blocks/rag', 'Kunnskap'],
  ['#/about/building-blocks/ki-infrastruktur/sigma2', 'Sigma2 og Olivia'],
  ['#/about/service-types', 'Typer KI-tjenester'],
  ['#/about/service-types/assistenter', 'Assistenter'],
  ['#/about/flows', 'Flyt'],
  ['#/about/flows/kunnskapsassistenten', 'Kunnskapsassistenten'],
  ['#/about/developers', 'For utviklere'],
] as const;

describe('public pages', () => {
  it.each(pages)(
    'renders %s with its heading and a login button, without signing in',
    async (hash, heading) => {
      open(hash);

      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
      expect(
        within(screen.getByRole('banner')).getByRole('button', { name: 'Logg inn' }),
      ).toBeTruthy();
      expect(screen.getByRole('navigation', { name: 'Om Genki' })).toBeTruthy();
      expectAccessible();
    },
  );

  it('marks the current section in the public navigation', async () => {
    open('#/about/building-blocks/rag');

    const nav = await screen.findByRole('navigation', { name: 'Om Genki' });
    expect(
      within(nav).getByRole('link', { name: 'Byggeklosser' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Flyt' }).getAttribute('aria-current')).toBeNull();
  });

  it('renders a building block page from the shared content', async () => {
    const block = defined(blockById('rag'));
    open('#/about/building-blocks/rag');

    await screen.findByRole('heading', { level: 1, name: block.name });
    expect(screen.getByText(block.tagline)).toBeTruthy();
    const parts = screen.getByRole('list', { name: 'Byggeklosser' });
    for (const component of componentsFor('rag'))
      expect(within(parts).getByRole('link', { name: component.name }).getAttribute('href')).toBe(
        `#/about/building-blocks/rag/${component.id}`,
      );
    expect(screen.getByRole('tab', { name: 'I koden' })).toBeTruthy();
    expect(screen.getByText(block.reuse)).toBeTruthy();
  });

  it('renders a building block part with its capabilities from the shared content', async () => {
    const first = defined(componentsFor('ki-gateway')[0]);
    const component = defined(componentById('ki-gateway', first.id));
    open(`#/about/building-blocks/ki-gateway/${component.id}`);

    await screen.findByRole('heading', { level: 1, name: component.name });
    for (const capability of component.capabilities)
      expect(screen.getByText(capability)).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: defined(blockById('ki-gateway')).name })
        .getAttribute('href'),
    ).toBe('#/about/building-blocks/ki-gateway');
  });

  it('opens a layer of the architecture figure on its building block page', async () => {
    open('#/about');

    const figure = await screen.findByLabelText('Målarkitekturen');
    fireEvent.click(within(figure).getByRole('button', { name: 'Kunnskap. Vis detaljer' }));
    expect(window.location.hash).toBe('#/about/building-blocks/rag');

    fireEvent.click(
      within(figure).getByRole('link', { name: 'Sigma2 og Olivia. Åpne byggeklossen' }),
    );
    expect(window.location.hash).toBe('#/about/building-blocks/ki-infrastruktur/sigma2');
  });

  it('steps through a flow and highlights the building block of each step', async () => {
    const flow = defined(caseById('kunnskapsassistenten'));
    open('#/about/flows/kunnskapsassistenten');

    await screen.findByText(`Steg 1 av ${flow.steps.length}`);
    fireEvent.click(screen.getByRole('button', { name: 'Neste steg' }));

    const second = defined(flow.steps[1]);
    expect(screen.getByText(`Steg 2 av ${flow.steps.length}`)).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: second.title })).toBeTruthy();
    const highlighted = screen
      .getByLabelText('Flyten steg for steg')
      .querySelector('.diagram-list [aria-current="step"]');
    expect(highlighted?.textContent).toContain(defined(blockById(second.block)).name);
  });

  it('shows the setup part of a flow from the address', async () => {
    const flow = defined(caseById('kunnskapsassistenten'));
    open('#/about/flows/kunnskapsassistenten?part=setup&step=2');

    expect(
      await screen.findByRole('heading', { level: 2, name: defined(flow.setup[1]).title }),
    ).toBeTruthy();
  });

  it('says a building block is missing instead of failing', async () => {
    open('#/about/building-blocks/finnes-ikke');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fant ikke byggeklossen' }),
    ).toBeTruthy();
    expect(screen.getByText('Fant ingen overordnet byggekloss med id «finnes-ikke».')).toBeTruthy();
  });

  it.each([
    '#/about/finnes-ikke',
    '#/about/status/finnes-ikke',
    '#/about/service-types/finnes-ikke',
  ])('shows a not found page with a heading for %s', async (hash) => {
    open(hash);

    const heading = await screen.findByRole('heading', { level: 1, name: /^Fant ikke/ });
    expect(document.title).toBe(`${heading.textContent} | Genki`);
    expectAccessible();
  });

  it('sends the old get-started address on to the developers page', async () => {
    open('#/about/get-started');

    expect(await screen.findByRole('heading', { level: 1, name: 'For utviklere' })).toBeTruthy();
    expect(window.location.hash).toBe('#/about/developers');
  });

  it('moves focus to the main content with the skip link without changing the page', async () => {
    open('#/about/flows');
    await screen.findByRole('heading', { level: 1, name: 'Flyt' });

    fireEvent.click(screen.getByRole('link', { name: 'Hopp til hovedinnhold' }));

    expect(window.location.hash).toBe('#/about/flows');
    expect(document.activeElement).toBe(screen.getByRole('main'));
    expect(screen.getByRole('heading', { level: 1, name: 'Flyt' })).toBeTruthy();
  });

  it('keeps the chosen language after a reload', async () => {
    open('#/about/flows');
    fireEvent.click(await screen.findByRole('button', { name: 'Mer' }));
    fireEvent.click(screen.getByRole('button', { name: 'English', hidden: true }));
    await screen.findByRole('heading', { level: 1, name: 'Flows' });
    cleanup();

    open('#/about/flows');

    expect(await screen.findByRole('heading', { level: 1, name: 'Flows' })).toBeTruthy();
  });

  it('shows the data handling page inside the public site with its own title', async () => {
    open('#/data-handling');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Slik behandles data' }),
    ).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Om Genki' })).toBeTruthy();
    expect(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Logg inn' }),
    ).toBeTruthy();
    expect(screen.getByRole('contentinfo')).toBeTruthy();
    expect(document.title).toBe('Slik behandles data | Genki');
    expectAccessible();
  });

  it('points the footer only at pages that exist', async () => {
    open('#/about/flows');
    await screen.findByRole('heading', { level: 1, name: 'Flyt' });

    const footer = screen.getByRole('navigation', { name: 'Bunntekst' });
    const targets = within(footer)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(targets).toEqual(['#/contact']);
    cleanup();

    open('#/contact');
    expect(await screen.findByRole('heading', { level: 1, name: 'Kontakt Digdir' })).toBeTruthy();
  });

  it('shows the chrome in English and says the content is still in Norwegian', async () => {
    open('#/about/building-blocks', ['en']);

    expect(await screen.findByRole('heading', { level: 1, name: 'Building blocks' })).toBeTruthy();
    expect(
      within(screen.getByRole('contentinfo')).getByText(
        /The documentation is only available in Norwegian for now\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('switches the public pages to English from the header', async () => {
    open('#/about/flows');

    fireEvent.click(await screen.findByRole('button', { name: 'Mer' }));
    fireEvent.click(screen.getByRole('button', { name: 'English', hidden: true }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Flows' })).toBeTruthy();
  });

  it('searches the content with Ctrl+K and opens a hit', async () => {
    const block = defined(blockById('rag'));
    open('#/about');
    await screen.findByRole('heading', { level: 1 });

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    const input = screen.getByRole('combobox', { name: 'Søk på nettstedet' });
    fireEvent.change(input, { target: { value: block.name } });

    const hits = screen.getByRole('listbox', { name: 'Treff' });
    const hit = within(hits).getAllByRole('link')[0] as HTMLElement;
    expect(hit.getAttribute('href')).toBe('#/about/building-blocks/rag');
    fireEvent.click(hit);
    expect(window.location.hash).toBe('#/about/building-blocks/rag');
  });

  it('shows all hits for a search on its own page', async () => {
    open('#/about/search?q=modell');

    expect(await screen.findByRole('heading', { level: 1, name: 'Søk' })).toBeTruthy();
    expect(screen.getByText(/treff for «modell»/)).toBeTruthy();
  });

  it('shows a figure in full screen and closes it with Escape', async () => {
    open('#/about');

    const figure = await screen.findByLabelText('Målarkitekturen');
    fireEvent.click(within(figure).getByRole('button', { name: 'Vis i fullskjerm' }));

    const full = await screen.findByRole('button', { name: 'Lukk fullskjerm' });
    expect(full.closest('.figure')?.classList.contains('is-full')).toBe(true);
    expect(full.closest('.docs-site')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Lukk fullskjerm' })).toBeNull();
  });

  it('lists everything with a status on the status page and filters by label', async () => {
    open('#/about/status/planlagt');

    expect(await screen.findByRole('heading', { level: 1, name: 'Merkelapper' })).toBeTruthy();
    const planned = screen.getByRole('radio', { name: /^Planlagt/ }) as HTMLInputElement;
    expect(planned.checked).toBe(true);
    const tags = [...document.querySelectorAll('.status-card .tag-link')];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag.textContent).toBe('Planlagt');
      expect(tag.getAttribute('href')).toBe('#/about/status/planlagt');
    }
    expectAccessible();
  });

  it('logs in from a public page and leaves the public address behind', async () => {
    open('#/about/flows');

    fireEvent.click(await screen.findByRole('button', { name: 'Logg inn' }));

    expect(
      await screen.findByRole('button', {
        name: 'Handler for Testetaten, org.nr. 999 888 777. Bytt virksomhet',
      }),
    ).toBeTruthy();
    expect(window.location.hash).not.toContain('about');
  });
});
