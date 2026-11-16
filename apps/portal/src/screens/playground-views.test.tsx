// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { expectAccessible, renderAt } from '../test-utils';

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
    // The try view draws its panels in more than one pass.
    await waitFor(() => expectAccessible(container));
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
    await screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' });
    const on = (await screen.findAllByRole('switch')).find(
      (s) => (s as HTMLInputElement).checked && !(s as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    const name = on.getAttribute('aria-label') ?? on.closest('label')?.textContent ?? '';
    fireEvent.click(on);
    expect(on.checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Lag en tjeneste av dette' }));
    expect(window.location.hash).toBe('#/services/new');
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' });

    go('#/services/new/interface');
    await screen.findByRole('heading', { name: 'Forhåndsvisning av tjenesten' });
    const inBuilder = (await screen.findAllByRole('switch')).find(
      (s) => (s.getAttribute('aria-label') ?? s.closest('label')?.textContent ?? '') === name,
    ) as HTMLInputElement;
    expect(inBuilder.checked).toBe(false);
  });
});
