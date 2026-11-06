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

  it('starts the preview in «Prøv tjenesten», with «Endre layout» as the other choice', async () => {
    await renderAt('#/playground');
    const modes = await screen.findByRole('group', { name: 'Visning' });
    const radios = within(modes).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual([
      'Prøv tjenesten',
      'Endre layout',
    ]);
    expect(radios[0]?.checked).toBe(true);
  });

  it('makes a new service that starts with the building blocks tried in the playground', async () => {
    await renderAt('#/playground');
    const projects = await screen.findByRole('switch', { name: /^Prosjekter/ });
    fireEvent.click(projects);
    expect((projects as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Lag en tjeneste av dette' }));
    expect(window.location.hash).toBe('#/services/new');
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' });

    go('#/services/new/blocks');
    const inBuilder = await screen.findByRole('switch', { name: /^Prosjekter/ });
    expect((inBuilder as HTMLInputElement).checked).toBe(false);
  });
});

describe('the building blocks handed to a new service', () => {
  it('reads only blocks, panels and starting points it knows', () => {
    expect(
      readStart('{"layout":{"placed":{"chat":"main"},"chosen":{}},"template":"chatOnly"}'),
    ).toEqual({ layout: { placed: { chat: 'main' }, chosen: {} }, template: 'chatOnly' });
    expect(readStart('{"layout":{"placed":{"chat":"top"},"chosen":{}}}')).toBeUndefined();
    expect(readStart('{"layout":{"placed":{"robot":"main"},"chosen":{}}}')).toBeUndefined();
    expect(readStart('not json')).toBeUndefined();
    expect(readStart(null)).toBeUndefined();
  });
});
