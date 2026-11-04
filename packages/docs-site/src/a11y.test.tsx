// @vitest-environment jsdom
import { blockById, caseById, malbilde } from '@genai/docs-content';
import { LocaleProvider } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ArchitectureDiagram } from './components/ArchitectureDiagram';
import { Figure } from './components/Figure';
import { HeroStack } from './components/HeroStack';
import { DocsSiteRoot } from './components/Root';
import { SearchDialog } from './components/SearchDialog';
import { DocsPage } from './DocsPage';
import type { Route } from './router';

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
});
afterEach(cleanup);

const inRoot = (ui: ReactNode, locale: 'nb' | 'en' = 'nb') =>
  render(
    <LocaleProvider preference={locale}>
      <DocsSiteRoot>{ui}</DocsSiteRoot>
    </LocaleProvider>,
  );

const defined = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing content');
  return value;
};

const architecture = () =>
  inRoot(
    <Figure label="Målarkitekturen" keyboardNav="figure">
      <ArchitectureDiagram />
    </Figure>,
  );

describe('architecture figure', () => {
  it('names the architecture figure as a group, not an image', () => {
    architecture();

    const svg = document.querySelector('svg.diagram');
    expect(svg?.getAttribute('role')).toBe('group');
    expect(svg?.getAttribute('aria-label')).toBeTruthy();
    expect(svg?.querySelector('[role="img"]:not([aria-hidden="true"])')).toBeNull();
  });

  it('wraps a figure in a named group', () => {
    architecture();

    expect(screen.getByRole('group', { name: 'Målarkitekturen' })).toBeTruthy();
  });

  it('moves focus to the next layer with the arrow keys in full screen', () => {
    architecture();
    fireEvent.click(screen.getByRole('button', { name: 'Vis i fullskjerm' }));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Autentisering. Vis detaljer');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Tilgangsstyring. Vis detaljer',
    );
  });

  it('closes full screen with Enter on the close button instead of opening a layer', () => {
    architecture();
    fireEvent.click(screen.getByRole('button', { name: 'Vis i fullskjerm' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowRight' });

    const close = screen.getByRole('button', { name: 'Lukk fullskjerm' });
    close.focus();
    const notPrevented = fireEvent.keyDown(close, { key: 'Enter' });

    expect(notPrevented).toBe(true);
    expect(window.location.hash).toBe('');
    fireEvent.click(close);
    expect(screen.queryByRole('button', { name: 'Lukk fullskjerm' })).toBeNull();
  });

  it('opens the focused layer with Enter in full screen', () => {
    architecture();
    fireEvent.click(screen.getByRole('button', { name: 'Vis i fullskjerm' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowRight' });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter' });

    expect(window.location.hash).toBe('#/byggeklosser/autentisering');
  });

  it('shows the fallback full screen as a modal dialog and returns focus when it closes', () => {
    architecture();
    fireEvent.click(screen.getByRole('button', { name: 'Vis i fullskjerm' }));

    const dialog = screen.getByRole('dialog', { name: 'Målarkitekturen' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Vis i fullskjerm' }));
  });
});

describe('layer figure', () => {
  it('tabs through the layer figure from the top', () => {
    inRoot(<HeroStack />);

    const order = [...document.querySelectorAll('svg.stack-figure [tabindex="0"]')].map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(order).toEqual([
      'Assistenter: les om denne typen KI-tjeneste',
      'Chatboter: les om denne typen KI-tjeneste',
      'Apper: les om denne typen KI-tjeneste',
      'Agenter: les om denne typen KI-tjeneste',
      'KI-tjenester: les mer',
      'Fellesløsning for KI: les mer',
      'Språkmodeller: les mer',
      'Infrastruktur for KI: les mer',
    ]);
  });
});

describe('search dialog', () => {
  it('names the search dialog and wires the combobox to the listbox', () => {
    inRoot(<SearchDialog open onClose={() => undefined} />);

    expect(document.querySelector('dialog')?.getAttribute('aria-label')).toBe('Søk på nettstedet');
    const input = screen.getByRole('combobox', { name: 'Søk på nettstedet' });
    fireEvent.change(input, { target: { value: defined(blockById('rag')).name } });

    const list = screen.getByRole('listbox', { name: 'Treff' });
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const options = within(list).getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    for (const link of list.querySelectorAll('a')) expect(link.tabIndex).toBe(-1);
  });

  it('announces the number of search hits', () => {
    inRoot(<SearchDialog open onClose={() => undefined} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'modell' } });

    expect(screen.getByRole('status').textContent).toMatch(/\d+ treff/);
  });
});

describe('flow page', () => {
  const flow = defined(caseById('kunnskapsassistenten'));
  const openFlow = () =>
    inRoot(<DocsPage route={{ page: 'tjenester', id: 'kunnskapsassistenten' }} />);

  it('announces the flow step while not playing', () => {
    openFlow();

    const step = screen.getByText(`Steg 1 av ${flow.steps.length}`);
    expect(step.getAttribute('aria-live')).toBe('polite');
    fireEvent.click(screen.getByRole('button', { name: 'Spill av' }));
    expect(screen.getByText(`Steg 1 av ${flow.steps.length}`).getAttribute('aria-live')).toBe(
      'off',
    );
  });

  it('ignores arrow keys when focus is outside the flow', () => {
    openFlow();

    const notPrevented = fireEvent.keyDown(document.body, { key: 'ArrowRight' });

    expect(notPrevented).toBe(true);
    expect(screen.getByText(`Steg 1 av ${flow.steps.length}`)).toBeTruthy();
  });

  it('changes step with the arrow keys when focus is in the flow', () => {
    openFlow();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Neste steg' }), { key: 'ArrowRight' });

    expect(screen.getByText(`Steg 2 av ${flow.steps.length}`)).toBeTruthy();
  });
});

describe('language of parts', () => {
  it('marks Norwegian content with lang nb when the locale is English', () => {
    const block = defined(blockById('rag'));
    inRoot(<DocsPage route={{ page: 'byggeklosser', id: 'rag' }} />, 'en');

    expect(screen.getByRole('heading', { level: 1, name: block.name }).getAttribute('lang')).toBe(
      'nb',
    );
    expect(screen.getByText(block.tagline).closest('[lang="nb"]')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'About' }).closest('[lang="nb"]')).toBeNull();
  });

  it('labels the figures in English when the locale is English', () => {
    inRoot(
      <>
        <HeroStack />
        <ArchitectureDiagram />
      </>,
      'en',
    );

    const figureText = [...document.querySelectorAll('svg text')].map((n) => n.textContent);
    for (const label of [
      'Assistants',
      'Chatbots',
      'AI services',
      'Language models',
      'Knowledge',
      'In-house',
    ])
      expect(figureText).toContain(label);
    for (const label of ['Assistenter', 'Språkmodeller', 'Kunnskap', 'Egen drift'])
      expect(figureText).not.toContain(label);
    expect(document.querySelector('svg [lang="nb"]')).toBeNull();
  });

  it('labels the target picture headings and items in English when the locale is English', () => {
    inRoot(<DocsPage route={{ page: 'malbilde' }} />, 'en');

    expect(screen.getByRole('heading', { level: 1, name: malbilde.en.title })).toBeTruthy();
    expect(screen.getByText(malbilde.gains[0].titleEn)).toBeTruthy();
    expect(screen.getByText(malbilde.gains[0].text).closest('[lang="nb"]')).toBeTruthy();
  });

  it('leaves content without a lang attribute when the locale is Norwegian', () => {
    inRoot(<DocsPage route={{ page: 'byggeklosser', id: 'rag' }} />);

    expect(document.body.querySelector('[lang="nb"]')).toBeNull();
  });

  it('marks Norwegian search results with lang nb when the locale is English', () => {
    inRoot(<SearchDialog open onClose={() => undefined} />, 'en');

    const titles = screen.getByRole('listbox').querySelectorAll('strong');
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title.getAttribute('lang')).toBe('nb');
  });

  it('shows search type tags in the same language as the titles', () => {
    inRoot(<SearchDialog open onClose={() => undefined} />, 'en');

    const tags = screen.getByRole('listbox').querySelectorAll('.ds-tag');
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag.getAttribute('lang')).toBe('nb');
    expect(screen.getAllByText('Overordnet byggekloss').length).toBeGreaterThan(0);
  });
});

describe('not found', () => {
  const missing: Route[] = [
    { page: 'byggeklosser', id: 'finnesikke' },
    { page: 'byggeklosser', id: 'rag', sub: 'finnesikke' },
    { page: 'typer', id: 'finnesikke' },
    { page: 'status', id: 'finnesikke' },
    { page: 'ikke-funnet' },
  ];

  it('gives every unknown id its own page heading', () => {
    for (const route of missing) {
      inRoot(<DocsPage route={route} />);
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toMatch(/^Fant ikke/);
      expect(document.title).toBe(`${heading.textContent} | Genki`);
      cleanup();
    }
  });

  it('clamps a flow step beyond the last step to the last step', () => {
    const flow = defined(caseById('kunnskapsassistenten'));
    inRoot(<DocsPage route={{ page: 'tjenester', id: flow.id, del: 'oppsett', steg: 99 }} />);

    expect(screen.getByText(`Steg ${flow.setup.length} av ${flow.setup.length}`)).toBeTruthy();
  });
});

describe('document title', () => {
  const pages: [Route, string][] = [
    [{ page: 'oversikt' }, 'Genki'],
    [{ page: 'malbilde' }, `${malbilde.title} | Genki`],
    [{ page: 'byggeklosser' }, 'Byggeklosser | Genki'],
    [{ page: 'byggeklosser', id: 'rag' }, `${defined(blockById('rag')).name} | Genki`],
    [{ page: 'byggeklosser', id: 'ki-infrastruktur', sub: 'sigma2' }, 'Sigma2 og Olivia | Genki'],
    [{ page: 'tjenester' }, 'Flyt | Genki'],
    [{ page: 'tjenester', id: 'kunnskapsassistenten' }, 'Kunnskapsassistenten | Genki'],
    [{ page: 'typer' }, 'Typer KI-tjenester | Genki'],
    [{ page: 'typer', id: 'assistenter' }, 'Assistenter | Genki'],
    [{ page: 'status' }, 'Merkelapper | Genki'],
    [{ page: 'sok', q: 'modell' }, 'Søk | Genki'],
    [{ page: 'kom-i-gang' }, 'For utviklere | Genki'],
  ];

  it('gives every docs page its own document title', () => {
    const titles = new Set<string>();
    for (const [route, title] of pages) {
      act(() => {
        inRoot(<DocsPage route={route} />);
      });
      expect(document.title).toBe(title);
      titles.add(document.title);
      cleanup();
    }
    expect(titles.size).toBe(pages.length);
  });
});
