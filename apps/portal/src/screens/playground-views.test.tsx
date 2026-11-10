// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { expectAccessible, renderAt } from '../test-utils';
import { readStart } from './services/blocks/handoff';

document.getAnimations ??= () => [];

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const views = () => screen.getByRole('tablist', { name: 'Prøveområdet' });

const go = (hash: string) =>
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

describe('the playground', () => {
  it('splits into Frontend and Backend tabs, Frontend first, with the content to try in Backend', async () => {
    await renderAt('#/playground/backend');
    expect(await screen.findByRole('textbox', { name: 'Spørsmål' })).toBeTruthy();
    const tabs = within(views()).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Frontend', 'Backend']);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('opens Frontend at the address of the playground', async () => {
    await renderAt('#/playground');
    await screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' });
    expect(
      within(views()).getByRole('tab', { name: 'Frontend' }).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('tries the interface in Frontend with the same building blocks as the builder, without its assistant', async () => {
    const { container } = await renderAt('#/playground');
    expect(
      await screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' }),
    ).toBeTruthy();
    const switcher = screen.getByRole('group', { name: 'Byggeklosser og maler' });
    expect(within(switcher).getByRole('radio', { name: 'Byggeklosser' })).toBeTruthy();
    expect(within(switcher).queryByRole('radio', { name: 'Chat' })).toBeNull();
    expectAccessible(container);
  });

  it('starts the preview in «Prøv assistenten», with «Oppsett» as the other choice', async () => {
    await renderAt('#/playground');
    const modes = await screen.findByRole('group', { name: 'Visning' });
    const radios = within(modes).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual([
      'Prøv assistenten',
      'Oppsett',
    ]);
    expect(radios[0]?.checked).toBe(true);
  });

  it('makes a new service that starts with the building blocks tried in the playground', async () => {
    await renderAt('#/playground');
    const threads = await screen.findByRole('switch', { name: /^Tråder/ });
    fireEvent.click(threads);
    expect((threads as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Lag en tjeneste av dette' }));
    expect(window.location.hash).toBe('#/services/new');
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' });

    go('#/services/new/blocks');
    const inBuilder = await screen.findByRole('switch', { name: /^Tråder/ });
    expect((inBuilder as HTMLInputElement).checked).toBe(false);
  });
});

const layoutOf = (zones: Record<string, unknown>) =>
  JSON.stringify({
    layout: { version: 1, zones: { primary: [], main: [], secondary: [], ...zones } },
  });

describe('the building blocks handed to a new service', () => {
  it('reads a layout of the catalogue, version 1, with its template, and its options', () => {
    const raw = JSON.stringify({
      layout: {
        version: 1,
        template: 'chat-only',
        zones: {
          primary: [],
          main: [{ block: 'chat', settings: { suggestions: false } }, { block: 'approach' }],
          secondary: [],
        },
      },
      template: 'chat-only',
    });
    expect(readStart(raw)).toEqual({
      layout: {
        version: 1,
        template: 'chat-only',
        zones: {
          primary: [],
          main: [{ block: 'approach' }, { block: 'chat', settings: { suggestions: false } }],
          secondary: [],
        },
      },
      template: 'chat-only',
    });
  });

  it('gives nothing for a layout that breaks a rule, is not a layout, or is not JSON', () => {
    expect(readStart(layoutOf({ main: [{ block: 'sources' }] }))).toBeUndefined();
    expect(readStart(layoutOf({ main: [{ block: 'robot' }] }))).toBeUndefined();
    expect(readStart(layoutOf({ secondary: [{ block: 'notes' }] }))).toBeUndefined();
    expect(readStart('{"layout":{"placed":{"chat":"main"},"chosen":{}}}')).toBeUndefined();
    expect(readStart('not json')).toBeUndefined();
    expect(readStart(null)).toBeUndefined();
  });

  it('leaves out a template it does not know, and keeps the layout', () => {
    const raw = JSON.stringify({
      ...JSON.parse(layoutOf({ main: [{ block: 'chat' }] })),
      template: 'chatOnly',
    });
    expect(readStart(raw)).toEqual({
      layout: { version: 1, zones: { primary: [], main: [{ block: 'chat' }], secondary: [] } },
    });
  });
});
