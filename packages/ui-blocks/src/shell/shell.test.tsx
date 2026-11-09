// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en, nb } from '../i18n.js';
import type { ShellLayout } from './layout.js';
import { Shell, type ShellProps, type ShellRequest } from './Shell.js';

// Ported from kunnskapsassistenten's layout tests: PanelSeparator, foldingDrag, drawers,
// LayoutProvider, PanelHead, sidebarFooterMode, compactMode and SidebarFooter. jsdom does no
// layout, so the window's width is the tests' own: the media queries and `clientWidth` answer it.

// ── A window of a given width ──
let viewport = 1440;
const queries = new Set<{ media: string; matches: boolean; listeners: Set<() => void> }>();
const answer = (media: string) => {
  const found = /^\(width < (\d+(?:\.\d+)?)px\)$/.exec(media);
  return found ? viewport < Number(found[1]) : false;
};
window.matchMedia = ((media: string) => {
  const query = { media, matches: answer(media), listeners: new Set<() => void>() };
  queries.add(query);
  return {
    get matches() {
      return query.matches;
    },
    media,
    addEventListener: (_: string, listener: () => void) => query.listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => query.listeners.delete(listener),
  } as unknown as MediaQueryList;
}) as typeof window.matchMedia;
Object.defineProperty(document.documentElement, 'clientWidth', {
  configurable: true,
  get: () => viewport,
});
const resizeTo = (width: number) =>
  act(() => {
    viewport = width;
    window.dispatchEvent(new Event('resize'));
    for (const query of queries) {
      const matches = answer(query.media);
      if (matches === query.matches) continue;
      query.matches = matches;
      for (const listener of [...query.listeners]) listener();
    }
  });

// jsdom has pointer events but no pointer capture, and a `<dialog>` with no top layer.
const capture = {
  set: HTMLElement.prototype.setPointerCapture,
  has: HTMLElement.prototype.hasPointerCapture,
  release: HTMLElement.prototype.releasePointerCapture,
};
beforeEach(() => {
  viewport = 1920;
  queries.clear();
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  HTMLElement.prototype.setPointerCapture = capture.set;
  HTMLElement.prototype.hasPointerCapture = capture.has;
  HTMLElement.prototype.releasePointerCapture = capture.release;
});

// ── The shell as kunnskapsassistenten lays it out ──
const draw = (props: Partial<ShellProps> = {}, width = viewport) => {
  viewport = width;
  const onLayoutChange = vi.fn<(layout: ShellLayout) => void>();
  const shell = (more: Partial<ShellProps> = {}) => (
    <Shell
      primary={{
        label: 'Tråder og filter',
        head: <button type="button">Tråder</button>,
        children: <a href="/t/1">En tråd</a>,
        foot: <a href="/innstillinger">Innstillinger</a>,
      }}
      secondary={{ label: 'Kilder', children: <a href="#kilde-1">Kilde 1</a> }}
      onLayoutChange={onLayoutChange}
      {...props}
      {...more}
    >
      <h1>Ny tråd</h1>
    </Shell>
  );
  const view = render(shell());
  return {
    ...view,
    onLayoutChange,
    redraw: (more: Partial<ShellProps>) => view.rerender(shell(more)),
  };
};

const primary = () => screen.getByRole('navigation', { name: 'Tråder og filter' });
const secondary = () => screen.getByRole('complementary', { name: 'Kilder' });
const button = (name: string) => screen.getByRole('button', { name });
const separator = (name = 'Endre bredde på tråder og filter') =>
  screen.getByRole('separator', { name });
const value = (element: HTMLElement) => Number(element.getAttribute('aria-valuenow'));
const folded = (panel: HTMLElement) => panel.hasAttribute('data-collapsed');

describe('the three columns', () => {
  it('are two named landmarks around the main column, named after what is in them', () => {
    draw();
    expect(primary().tagName).toBe('NAV');
    expect(secondary().tagName).toBe('ASIDE');
    expect(screen.getByRole('main').id).toBe('main-content');
    expect(screen.getByRole('heading', { name: 'Ny tråd' })).toBeTruthy();
  });

  it('start with the primary panel open and the secondary one on its rail', () => {
    draw();
    expect(folded(primary())).toBe(false);
    expect(folded(secondary())).toBe(true);
  });

  it('offer «Hopp til hovedinnhold» first, and the host’s own skip links after it', () => {
    draw({ skipLinks: <a href="#composer-field">Hopp til skrivefeltet (Ctrl + /)</a> });
    const links = screen.getAllByRole('link').slice(0, 2);
    expect(links.map((link) => link.textContent)).toEqual([
      'Hopp til hovedinnhold',
      'Hopp til skrivefeltet (Ctrl + /)',
    ]);
    expect(links[0]?.getAttribute('href')).toBe('#main-content');
  });

  it('leave a panel out when the host gives none', () => {
    draw({ secondary: undefined });
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(primary()).toBeTruthy();
  });

  it('follow the host’s colour family unless the host gives one', () => {
    const { container, redraw } = draw();
    const root = () => container.querySelector('.uib-shell');
    expect(root()?.hasAttribute('data-color')).toBe(false);
    redraw({ color: 'brand1' });
    expect(root()?.getAttribute('data-color')).toBe('brand1');
  });
});

describe('the button that folds a panel', () => {
  it('says «Skjul» on the open primary panel, and its name starts with the word', () => {
    draw();
    const hide = button('Skjul tråder og filter');
    expect(hide.textContent).toBe('Skjul');
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(hide.getAttribute('aria-controls') ?? '')).toBeTruthy();
  });

  it('is an icon with the whole name on a rail, and still says what it controls', () => {
    draw();
    const show = button('Vis kilder');
    expect(show.textContent).toBe('');
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(show.getAttribute('aria-controls') ?? '')?.hidden).toBe(true);
  });

  it('folds the panel to a rail, keeps the content in the page, and opens it again', () => {
    draw();
    fireEvent.click(button('Skjul tråder og filter'));
    expect(folded(primary())).toBe(true);
    expect(within(primary()).queryByRole('link', { name: 'En tråd' })).toBeNull();
    expect(within(primary()).queryByRole('button', { name: 'Tråder' })).toBeNull();
    fireEvent.click(button('Vis tråder og filter'));
    expect(folded(primary())).toBe(false);
    expect(within(primary()).getByRole('link', { name: 'En tråd' })).toBeTruthy();
  });

  it('stands last on the primary panel’s row and first on the secondary one’s', () => {
    draw();
    fireEvent.click(button('Vis kilder'));
    const row = (panel: HTMLElement) =>
      [...(panel.querySelector('.uib-shell-header')?.children ?? [])].map(
        (child) => child.textContent,
      );
    expect(row(primary())).toEqual(['Tråder', 'Skjul']);
    expect(row(secondary())[0]).toBe('');
  });
});

describe('the edge between a panel and the main column', () => {
  it('is a separator named after the panel, reporting its width in pixels', () => {
    draw();
    const edge = separator();
    expect(edge.getAttribute('aria-orientation')).toBe('vertical');
    expect(value(edge)).toBe(400);
    expect(edge.getAttribute('aria-valuemin')).toBe('400');
    // 1920 − 67 (the secondary rail) − 32 − 640.
    expect(edge.getAttribute('aria-valuemax')).toBe('1181');
    expect(edge.getAttribute('aria-valuetext')).toBe('400 piksler');
    expect(edge.tabIndex).toBe(0);
  });

  it('moves 16 px on an arrow key and 64 with Shift, and keeps the page still', () => {
    draw();
    const edge = separator();
    const right = fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(right).toBe(false);
    expect(value(separator())).toBe(416);
    fireEvent.keyDown(separator(), { key: 'ArrowRight', shiftKey: true });
    expect(value(separator())).toBe(480);
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    expect(value(separator())).toBe(464);
  });

  it('moves the way the key points, so the panel after the main column narrows on the right arrow', () => {
    draw();
    fireEvent.click(button('Vis kilder'));
    const edge = separator('Endre bredde på kilder');
    fireEvent.keyDown(edge, { key: 'ArrowRight' });
    expect(value(separator('Endre bredde på kilder'))).toBe(432 - 16);
  });

  it('goes to the floor on Home, the ceiling on End, and the design’s width on Enter', () => {
    draw();
    fireEvent.keyDown(separator(), { key: 'End' });
    expect(value(separator())).toBe(1181);
    fireEvent.keyDown(separator(), { key: 'Home' });
    expect(value(separator())).toBe(400);
    fireEvent.keyDown(separator(), { key: 'End' });
    fireEvent.keyDown(separator(), { key: 'Enter' });
    expect(value(separator())).toBe(400);
  });

  it('stops at the bounds instead of running past them', () => {
    draw();
    fireEvent.keyDown(separator(), { key: 'ArrowLeft' });
    expect(value(separator())).toBe(400);
  });

  it('leaves keys it has no business with alone', () => {
    draw();
    expect(fireEvent.keyDown(separator(), { key: 'a' })).toBe(true);
  });

  it('is not there when there is no edge to move, as at 1440 with both panels open', () => {
    draw({ initialLayout: { collapsed: { secondary: false } } }, 1440);
    expect(screen.queryByRole('separator')).toBeNull();
    resizeTo(1600);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
  });

  it('reports the width on screen, not one asked for in a wider window', () => {
    draw({ initialLayout: { widths: { primary: 900 } } }, 1300);
    expect(value(separator())).toBe(1300 - 67 - 32 - 640);
  });

  it('widens on a click to what the window allows, and goes back on the next', () => {
    draw();
    const edge = separator();
    fireEvent.pointerDown(edge, { button: 0, clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 402, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 402, pointerId: 1 });
    fireEvent.click(edge);
    expect(value(separator())).toBe(1181);
    fireEvent.pointerDown(separator(), { button: 0, clientX: 1181, pointerId: 1 });
    fireEvent.pointerUp(separator(), { clientX: 1181, pointerId: 1 });
    fireEvent.click(separator());
    expect(value(separator())).toBe(400);
  });

  it('lets a drag be a drag, also when it ends in a click', () => {
    draw();
    const edge = separator();
    fireEvent.pointerDown(edge, { button: 0, clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(edge, { clientX: 500, pointerId: 1 });
    fireEvent.click(edge);
    expect(value(separator())).toBe(500);
  });

  it('takes focus on a press, so the arrow keys carry on from there', () => {
    draw();
    fireEvent.pointerDown(separator(), { button: 0, clientX: 400, pointerId: 1 });
    expect(document.activeElement).toBe(separator());
  });

  it('ignores a right click, which is a menu', () => {
    draw();
    fireEvent.pointerDown(separator(), { button: 2, clientX: 400, pointerId: 1 });
    fireEvent.pointerMove(separator(), { clientX: 600, pointerId: 1 });
    expect(value(separator())).toBe(400);
  });
});

describe('a drag past half the floor', () => {
  const press = (x: number) =>
    fireEvent.pointerDown(separator(), { button: 0, clientX: x, pointerId: 1 });
  const move = (x: number) => fireEvent.pointerMove(separator(), { clientX: x, pointerId: 1 });

  it('folds the panel instead of stopping at the floor, saying «Skjult» while held', () => {
    draw();
    press(400);
    move(199);
    expect(folded(primary())).toBe(true);
    expect(separator().getAttribute('aria-valuetext')).toBe('Skjult');
    expect(value(separator())).toBe(400);
  });

  it('stops at the floor when it only overshoots it', () => {
    draw();
    press(400);
    move(250);
    expect(folded(primary())).toBe(false);
    expect(value(separator())).toBe(400);
  });

  it('opens again 16 px back past the line, at the width the drag began with', () => {
    draw({ initialLayout: { widths: { primary: 480 } } });
    press(480);
    move(100);
    expect(folded(primary())).toBe(true);
    move(200 + 15);
    expect(folded(primary())).toBe(true);
    move(200 + 16);
    expect(folded(primary())).toBe(false);
    expect(value(separator())).toBe(400);
  });

  it('folds the secondary panel when dragged the other way', () => {
    draw();
    fireEvent.click(button('Vis kilder'));
    const edge = separator('Endre bredde på kilder');
    fireEvent.pointerDown(edge, { button: 0, clientX: 1488, pointerId: 1 });
    fireEvent.pointerMove(edge, { clientX: 1488 + 300, pointerId: 1 });
    expect(folded(secondary())).toBe(true);
  });

  it('keeps the separator over the rail until let go, then sends the focus to the button', () => {
    draw();
    press(400);
    move(100);
    expect(separator()).toBeTruthy();
    fireEvent.pointerUp(separator(), { clientX: 100, pointerId: 1 });
    expect(
      screen.queryByRole('separator', { name: 'Endre bredde på tråder og filter' }),
    ).toBeNull();
    expect(document.activeElement).toBe(button('Vis tråder og filter'));
  });

  it('opens again at the width the drag began with, not at the floor', () => {
    draw({ initialLayout: { widths: { primary: 520 } } });
    press(520);
    move(100);
    fireEvent.pointerUp(separator(), { clientX: 100, pointerId: 1 });
    fireEvent.click(button('Vis tråder og filter'));
    expect(value(separator())).toBe(520);
  });
});

describe('one open panel where both do not fit, below 1440', () => {
  it('folds the primary panel when the secondary one opens, and the other way', () => {
    draw({}, 1300);
    fireEvent.click(button('Vis kilder'));
    expect([folded(primary()), folded(secondary())]).toEqual([true, false]);
    fireEvent.click(button('Vis tråder og filter'));
    expect([folded(primary()), folded(secondary())]).toEqual([false, true]);
  });

  it('folds the secondary panel at once in a window that is already too narrow', () => {
    draw({ initialLayout: { collapsed: { secondary: false } } }, 1300);
    expect([folded(primary()), folded(secondary())]).toEqual([false, true]);
  });

  it('folds the secondary panel when the window shrinks past it, and opens nothing growing back', () => {
    draw({ initialLayout: { collapsed: { secondary: false } } }, 1600);
    expect(folded(secondary())).toBe(false);
    resizeTo(1300);
    expect(folded(secondary())).toBe(true);
    resizeTo(1600);
    expect(folded(secondary())).toBe(true);
  });

  it('leaves both open at the breakpoint itself', () => {
    draw({ initialLayout: { collapsed: { secondary: false } } }, 1440);
    expect([folded(primary()), folded(secondary())]).toEqual([false, false]);
  });
});

describe('drawers, below 1139', () => {
  it('land with both panels on their rails, and no drawer drawn above the breakpoint', () => {
    draw({}, 1920);
    expect(document.querySelector('dialog')).toBeNull();
    cleanup();
    draw({ initialLayout: { collapsed: { primary: false } } }, 1000);
    expect([folded(primary()), folded(secondary())]).toEqual([true, true]);
    expect(button('Vis tråder og filter').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a named drawer from the rail’s button, with its own close button', () => {
    draw({}, 1000);
    fireEvent.click(button('Vis tråder og filter'));
    const drawer = document.querySelector<HTMLDialogElement>(
      'dialog[aria-label="Tråder og filter"]',
    );
    expect(drawer?.open).toBe(true);
    expect(button('Skjul tråder og filter').getAttribute('aria-expanded')).toBe('true');
    expect(
      within(drawer as HTMLElement).getByRole('button', { name: 'Lukk tråder og filter' }),
    ).toBeTruthy();
    expect(within(drawer as HTMLElement).getByRole('button', { name: 'Tråder' })).toBeTruthy();
    expect(within(drawer as HTMLElement).getByRole('link', { name: 'Innstillinger' })).toBeTruthy();
  });

  it('has no separator: a drawer has no edge to share', () => {
    draw({}, 1000);
    fireEvent.click(button('Vis tråder og filter'));
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('keeps one drawer open at a time', () => {
    draw({}, 1000);
    fireEvent.click(button('Vis tråder og filter'));
    fireEvent.click(button('Vis kilder'));
    expect(button('Vis tråder og filter').getAttribute('aria-expanded')).toBe('false');
  });

  it('folds an open panel away when the window shrinks past 1139', () => {
    draw({}, 1300);
    expect(folded(primary())).toBe(false);
    resizeTo(1000);
    expect(button('Vis tråder og filter')).toBeTruthy();
    resizeTo(1300);
    expect(button('Vis tråder og filter')).toBeTruthy();
  });
});

// kunnskapsassistenten's `mobile-top-row` (kunnskapsassistenten#120), the standard here.
describe('the top row, below 774', () => {
  const row = () => document.querySelector('.uib-shell')?.hasAttribute('data-compact');

  it('below 774 px the rails are one row at the top, by default', () => {
    draw({}, 390);
    expect(row()).toBe(true);
    expect([folded(primary()), folded(secondary())]).toEqual([true, true]);
    expect(button('Vis tråder og filter').getAttribute('aria-expanded')).toBe('false');
    expect(button('Vis kilder').getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the tab order: the primary button, the main column, then the secondary button', () => {
    draw({}, 390);
    const order = [button('Vis tråder og filter'), screen.getByRole('main'), button('Vis kilder')];
    for (const [before, after] of [
      [order[0], order[1]],
      [order[1], order[2]],
    ] as const)
      expect(before?.compareDocumentPosition(after as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('gives the main column the whole window, since the rails take nothing from its row', () => {
    const { container } = draw({}, 390);
    const shell = container.querySelector<HTMLElement>('.uib-shell');
    expect(shell?.style.getPropertyValue('--uib-shell-main-min-width')).toBe('390px');
  });

  it('is not there at 774 px and wider, and follows the window without a reload', () => {
    draw({}, 774);
    expect(row()).toBe(false);
    resizeTo(773);
    expect(row()).toBe(true);
    resizeTo(1000);
    expect(row()).toBe(false);
    resizeTo(393);
    expect(row()).toBe(true);
  });

  it('is off when the host sets compactBar to false: the rails stay at the sides', () => {
    const { container } = draw({ compactBar: false }, 390);
    expect(row()).toBe(false);
    const shell = container.querySelector<HTMLElement>('.uib-shell');
    expect(shell?.hasAttribute('data-drawer')).toBe(true);
    expect(shell?.style.getPropertyValue('--uib-shell-main-min-width')).toBe('256px');
  });

  it('opens each panel as a drawer from its button, one at a time', () => {
    draw({}, 390);
    fireEvent.click(button('Vis tråder og filter'));
    const threads = document.querySelector<HTMLDialogElement>(
      'dialog[aria-label="Tråder og filter"]',
    );
    expect(threads?.open).toBe(true);
    expect(within(threads as HTMLElement).getByRole('link', { name: 'En tråd' })).toBeTruthy();
    fireEvent.click(button('Vis kilder'));
    const sources = document.querySelector<HTMLDialogElement>('dialog[aria-label="Kilder"]');
    expect(sources?.open).toBe(true);
    expect(threads?.open).toBe(false);
  });

  it('gives the focus back to the button that opened the drawer when the drawer closes', () => {
    draw({}, 390);
    fireEvent.click(button('Vis kilder'));
    const drawer = document.querySelector<HTMLDialogElement>('dialog[aria-label="Kilder"]');
    const link = within(drawer as HTMLElement).getByRole('link', { name: 'Kilde 1' });
    act(() => link.focus());
    fireEvent.focus(link);
    // What the browser does on Escape: it closes the dialog and fires `close`.
    act(() => {
      drawer?.close();
      drawer?.dispatchEvent(new Event('close'));
    });
    expect(document.activeElement).toBe(button('Vis kilder'));
    expect(button('Vis kilder').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('what the host asks for', () => {
  const ask = (request: ShellRequest) => request;

  it('opens a panel the reader asked for, folding the other one where both do not fit', () => {
    const { redraw } = draw({}, 1300);
    redraw({ request: ask({ action: 'open', side: 'secondary' }) });
    expect([folded(primary()), folded(secondary())]).toEqual([true, false]);
  });

  it('acts on each request once, and again on a new one', () => {
    const { redraw } = draw();
    const request = ask({ action: 'open', side: 'secondary' });
    redraw({ request });
    fireEvent.click(button('Skjul kilder'));
    redraw({ request });
    expect(folded(secondary())).toBe(true);
    redraw({ request: { ...request } });
    expect(folded(secondary())).toBe(false);
  });

  it('opens an offered panel where there is room', () => {
    const { redraw } = draw();
    redraw({ request: ask({ action: 'offer', side: 'secondary' }) });
    expect(folded(secondary())).toBe(false);
  });

  it('leaves an offered panel shut once the reader shut it, until the reader asks for it', () => {
    const { redraw } = draw();
    fireEvent.click(button('Vis kilder'));
    fireEvent.click(button('Skjul kilder'));
    redraw({ request: ask({ action: 'offer', side: 'secondary' }) });
    expect(folded(secondary())).toBe(true);
    redraw({ request: ask({ action: 'open', side: 'secondary' }) });
    expect(folded(secondary())).toBe(false);
  });

  it('does not count the narrow rule’s fold as the reader’s choice', () => {
    const { redraw } = draw({ initialLayout: { collapsed: { secondary: false } } }, 1600);
    resizeTo(1300);
    fireEvent.click(button('Skjul tråder og filter'));
    redraw({ request: ask({ action: 'offer', side: 'secondary' }) });
    expect(folded(secondary())).toBe(false);
  });

  it('does not open an offered panel at the cost of the other one where both do not fit', () => {
    const { redraw } = draw({}, 1300);
    redraw({ request: ask({ action: 'offer', side: 'secondary' }) });
    expect(folded(secondary())).toBe(true);
    fireEvent.click(button('Skjul tråder og filter'));
    redraw({ request: ask({ action: 'offer', side: 'secondary' }) });
    expect(folded(secondary())).toBe(false);
  });

  it('never offers a drawer, which would cover what just arrived', () => {
    const { redraw } = draw({}, 1000);
    redraw({ request: ask({ action: 'offer', side: 'secondary' }) });
    expect(button('Vis kilder').getAttribute('aria-expanded')).toBe('false');
  });

  it('shuts an open drawer, and leaves a panel beside the main column alone', () => {
    const { redraw } = draw({}, 1000);
    fireEvent.click(button('Vis tråder og filter'));
    redraw({ request: ask({ action: 'close-drawers' }) });
    expect(button('Vis tråder og filter').getAttribute('aria-expanded')).toBe('false');
    resizeTo(1600);
    fireEvent.click(button('Vis tråder og filter'));
    redraw({ request: ask({ action: 'close-drawers' }) });
    expect(folded(primary())).toBe(false);
  });
});

describe('what the host stores', () => {
  it('hears nothing on the first render, when nothing has changed', () => {
    const { onLayoutChange } = draw();
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('hears every change the reader makes: folding, shutting and widths they moved', () => {
    const { onLayoutChange } = draw();
    fireEvent.click(button('Vis kilder'));
    fireEvent.click(button('Skjul kilder'));
    fireEvent.keyDown(separator(), { key: 'ArrowRight' });
    expect(onLayoutChange).toHaveBeenLastCalledWith({
      collapsed: { primary: false, secondary: true },
      widths: { primary: 416 },
      dismissed: { primary: false, secondary: true },
    });
  });

  it('forgets a width that is back at the design’s', () => {
    const { onLayoutChange } = draw({ initialLayout: { widths: { primary: 480 } } });
    fireEvent.keyDown(separator(), { key: 'Enter' });
    expect(onLayoutChange.mock.lastCall?.[0].widths).toEqual({});
  });

  it('hears a fold the narrow rule made on a page load, so a reload keeps it', () => {
    const { onLayoutChange } = draw({ initialLayout: { collapsed: { secondary: false } } }, 1300);
    expect(onLayoutChange.mock.lastCall?.[0].collapsed).toEqual({
      primary: false,
      secondary: true,
    });
  });

  it('starts from what the host stored', () => {
    draw({
      initialLayout: { collapsed: { primary: true, secondary: false }, widths: { secondary: 500 } },
    });
    expect(folded(primary())).toBe(true);
    expect(value(separator('Endre bredde på kilder'))).toBe(500);
  });

  it('never stores anything itself', () => {
    localStorage.clear();
    draw();
    fireEvent.click(button('Vis kilder'));
    expect(localStorage.length).toBe(0);
  });
});

describe('the head, the pinned head and the foot', () => {
  it('puts the host’s head on the panel’s own row, and not on a rail', () => {
    draw();
    const row = primary().querySelector('.uib-shell-header') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Tråder' })).toBeTruthy();
    fireEvent.click(button('Skjul tråder og filter'));
    expect(screen.queryByRole('button', { name: 'Tråder' })).toBeNull();
  });

  it('pins the host’s heads first in each scrolling region', () => {
    draw({
      mainPinned: <p>Variant</p>,
      primary: {
        label: 'Tråder og filter',
        pinned: <h2>Tidligere tråder</h2>,
        children: <p>Liste</p>,
      },
    });
    const region = primary().querySelector('.uib-shell-content');
    expect(region?.firstElementChild?.textContent).toBe('Tidligere tråder');
    expect(screen.getByRole('main').querySelector('.uib-shell-pinned')?.textContent).toBe(
      'Variant',
    );
  });

  it('hands the host its pinned region, for a block that draws its own head there', () => {
    const given: (HTMLDivElement | null)[] = [];
    const pinnedRef = (element: HTMLDivElement | null) => given.push(element);
    const { unmount } = draw({
      primary: { label: 'Tråder og filter', pinnedRef, children: <p>Felter</p> },
    });
    const region = primary().querySelector('.uib-shell-pinned');
    expect(given).toEqual([region]);
    unmount();
    expect(given).toEqual([region, null]);
  });

  it('pads a panel’s region as tall as its pinned head as soon as it opens, not a frame later', () => {
    // jsdom does no layout: the pinned head is 48 pixels while it is shown.
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        const shown = !this.closest('[hidden], dialog:not([open])');
        return shown && this.classList.contains('uib-shell-pinned') ? 48 : 0;
      },
    });
    try {
      const secondaryPanel = {
        label: 'Kilder',
        pinned: <p>Verktøy</p>,
        children: <a href="#kilde-1">Kilde 1</a>,
      };
      draw({ secondary: secondaryPanel });
      const region = () => secondary().querySelector<HTMLElement>('.uib-shell-content');
      expect(region()?.style.scrollPaddingBlockStart).toBe('0px');
      // No observer has reported, and no frame has passed.
      fireEvent.click(button('Vis kilder'));
      expect(region()?.style.scrollPaddingBlockStart).toBe('48px');
      fireEvent.click(button('Skjul kilder'));
      expect(region()?.style.scrollPaddingBlockStart).toBe('0px');
      // A drawer is measured once its dialog is open.
      cleanup();
      draw({ secondary: secondaryPanel }, 1000);
      fireEvent.click(button('Vis kilder'));
      expect(secondary().querySelector('dialog')?.open).toBe(true);
      expect(region()?.style.scrollPaddingBlockStart).toBe('48px');
    } finally {
      if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height);
    }
  });

  it('ends the scrolling region with the foot, or pins it under when asked', () => {
    const { redraw } = draw();
    const foot = () =>
      screen.getByRole('link', { name: 'Innstillinger' }).closest('.uib-shell-foot');
    expect(foot()?.parentElement?.classList.contains('uib-shell-content')).toBe(true);
    redraw({
      primary: {
        label: 'Tråder og filter',
        foot: <a href="/innstillinger">Innstillinger</a>,
        footPinned: true,
      },
    });
    expect(foot()?.parentElement?.classList.contains('uib-shell-box')).toBe(true);
    expect(screen.getAllByRole('link', { name: 'Innstillinger' })).toHaveLength(1);
  });

  it('draws no foot on a rail', () => {
    draw();
    fireEvent.click(button('Skjul tråder og filter'));
    expect(screen.queryByRole('link', { name: 'Innstillinger' })).toBeNull();
  });
});

describe('the focus', () => {
  it('goes to the button when the panel it was in folds', () => {
    draw();
    const link = within(primary()).getByRole('link', { name: 'En tråd' });
    act(() => link.focus());
    fireEvent.focus(link);
    fireEvent.click(button('Skjul tråder og filter'));
    expect(document.activeElement).toBe(button('Vis tråder og filter'));
  });
});

describe('the words', () => {
  it('are English when the person’s are', () => {
    render(
      <InLocale locale="en">
        <Shell primary={{ label: 'Threads' }}>
          <p>Main</p>
        </Shell>
      </InLocale>,
    );
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide threads' }).textContent).toBe('Hide');
    expect(
      screen.getByRole('separator', { name: 'Resize threads' }).getAttribute('aria-valuetext'),
    ).toBe('400 pixels');
  });

  it('have an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
