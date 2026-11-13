// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { defaultLayout, fromTemplate } from '@genai/ui-blocks/builder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAccessible, go, renderAt } from '../../../test-utils';
import { keepStart, keptStart, layoutJson, readLayout } from './layoutStore';

const own = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  window.location.hash = '';
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  if (own) Object.defineProperty(navigator, 'clipboard', own);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

const navLink = (name: string) =>
  within(screen.getByRole('navigation', { name: 'Tjenesten' })).getByRole('link', { name });

const openInterface = async (service = 'rapportassistenten', name = 'Rapportassistenten') => {
  await renderAt(`#/services/${service}/interface`);
  await screen.findByRole('heading', { level: 1, name });
  await screen.findByRole('group', { name: 'Byggeklosser og maler' });
};

const switchIn = (group: string, name: string) =>
  within(screen.getByRole('group', { name: group })).getByRole('switch', {
    name,
  }) as HTMLInputElement;

const next = fromTemplate('knowledge-assistant-next').layout;

// The layout the tab keeps for a service, whichever tenant the mock signs in to.
const keptFor = (service: string) => {
  const key = Object.keys(sessionStorage).find(
    (k) => k.startsWith('genki.blocks.') && k.endsWith(`/${service}`),
  );
  const tenant = key?.slice('genki.blocks.'.length, -(service.length + 1));
  return tenant === undefined ? undefined : keptStart(tenant, service);
};

describe('the Grensesnitt tab', () => {
  it('is on the page of a service that is published, and starts from the next look of Kunnskapsassistenten', async () => {
    await openInterface();
    expect(navLink('Grensesnitt').getAttribute('aria-current')).toBe('page');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Maler' }));
    expect(
      screen.getByRole('button', { name: 'Bruk Kunnskapsassistenten, ny utgave' }).ariaPressed,
    ).toBe('true');
    expectAccessible();
  });

  it('is on the page of a new service, between Oppsett and Test', async () => {
    await renderAt('#/services/new');
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' });
    fireEvent.click(screen.getByRole('button', { name: /Henter ut opplysninger/ }));
    await screen.findByText('Satte jobb: henter ut opplysninger');
    const nav = screen.getByRole('navigation', { name: 'Tjenesten' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Oppsett',
      'Grensesnitt',
      'Test',
      'Versjoner',
    ]);
    fireEvent.click(navLink('Grensesnitt'));
    expect(await screen.findByRole('group', { name: 'Byggeklosser og maler' })).toBeTruthy();
    expectAccessible();
  });

  it('keeps the layout in this browser when the person goes to another tab and back', async () => {
    await openInterface();
    expect(switchIn('Høyre panel', 'Kilder').checked).toBe(true);
    fireEvent.click(switchIn('Høyre panel', 'Kilder'));
    go('#/services/rapportassistenten/setup');
    await waitFor(() => expect(navLink('Oppsett').getAttribute('aria-current')).toBe('page'));
    go('#/services/rapportassistenten/interface');
    await screen.findByRole('group', { name: 'Byggeklosser og maler' });
    expect(switchIn('Høyre panel', 'Kilder').checked).toBe(false);
  });
});

describe('«Kopier oppsettet»', () => {
  it('copies the layout as JSON that «Lim inn oppsett» reads back', async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openInterface();
    fireEvent.click(screen.getByRole('button', { name: 'Kopier oppsettet' }));
    await screen.findByText('Oppsettet er kopiert som JSON.');
    const copied = readLayout(writeText.mock.calls[0]?.[0] ?? '');
    expect(copied).toEqual({ layout: keptFor('rapportassistenten')?.layout });
    expect('layout' in copied && copied.layout.template).toBe('knowledge-assistant-next');
  });

  it('shows the JSON to copy by hand when the browser refuses', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await openInterface();
    fireEvent.click(screen.getByRole('button', { name: 'Kopier oppsettet' }));
    await screen.findByText(/Nettleseren lot ikke portalen kopiere/);
    const shown = (screen.getByLabelText('Oppsettet') as HTMLTextAreaElement).value;
    expect(readLayout(shown)).toEqual({ layout: keptFor('rapportassistenten')?.layout });
  });
});

describe('«Lim inn oppsett»', () => {
  const paste = (text: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Lim inn oppsett' }));
    fireEvent.change(screen.getByLabelText('Oppsett som JSON'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
  };

  it('uses a pasted layout that keeps the rules, and keeps it', async () => {
    await openInterface();
    expect(switchIn('Venstre panel', 'Filter').checked).toBe(false);
    paste(layoutJson(defaultLayout));
    await screen.findByText('Oppsettet du limte inn, er i bruk.');
    expect(switchIn('Høyre panel', 'Fremgangsmåte').checked).toBe(false);
    expect(switchIn('Innhold', 'Fremgangsmåte').checked).toBe(true);
    const kept = keptFor('rapportassistenten')?.layout;
    expect(kept?.zones.main.map((placed) => placed.block)).toEqual(
      defaultLayout.zones.main.map((placed) => placed.block),
    );
  });

  it('says why it refuses text that is not JSON, not a layout, or breaks a rule, and keeps the layout', async () => {
    await openInterface();
    paste('{ not json');
    expect(screen.getByText('Teksten er ikke gyldig JSON.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Oppsett som JSON'), {
      target: { value: '{"version":2}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    expect(screen.getByText('Teksten er ikke et oppsett av byggeklosser.')).toBeTruthy();
    const twice = {
      version: 1,
      zones: { primary: [{ block: 'chat' }], main: [{ block: 'chat' }], secondary: [] },
    };
    fireEvent.change(screen.getByLabelText('Oppsett som JSON'), {
      target: { value: JSON.stringify(twice) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Bruk oppsettet' }));
    expect(screen.getByText(/Oppsettet bryter reglene for byggeklossene:.*Chat/)).toBeTruthy();
    expect(screen.getByLabelText('Oppsett som JSON').getAttribute('aria-invalid')).toBe('true');
    expect(switchIn('Høyre panel', 'Kilder').checked).toBe(true);
    expectAccessible();
  });
});

describe('the layout kept in this browser', () => {
  it('is kept per tenant and service, and a stored text that breaks a rule is not read', () => {
    keepStart('digdir', 'a', { layout: defaultLayout });
    keepStart('digdir', 'b', { layout: next, template: 'knowledge-assistant-next' });
    expect(keptStart('digdir', 'a')).toEqual({ layout: defaultLayout });
    expect(keptStart('digdir', 'b')?.template).toBe('knowledge-assistant-next');
    expect(keptStart('other', 'a')).toBeUndefined();
    sessionStorage.setItem(
      'genki.blocks.digdir/c',
      JSON.stringify({ layout: { version: 1, zones: { primary: [], main: [], secondary: [] } } }),
    );
    expect(keptStart('digdir', 'c')).toBeDefined();
    sessionStorage.setItem('genki.blocks.digdir/d', '{"layout":{"version":1}}');
    expect(keptStart('digdir', 'd')).toBeUndefined();
  });
});
