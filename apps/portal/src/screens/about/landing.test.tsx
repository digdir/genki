// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch } from '../../mock';
import { kari, renderAt } from '../../test-utils';
import { landingStorageKey } from './landing';

const oldHeading = 'Generativ KI for offentlige virksomheter, drevet av Digdir';
const newSection = 'Slik er Genki bygd';
const previewSwitch = () => screen.getByRole('switch', { name: 'Ny startside (forhåndsvisning)' });

const renderSignedOut = () => render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} />);

beforeEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('landing toggle', () => {
  it('shows the old start page by default with the preview switch off', () => {
    renderSignedOut();

    expect(screen.getByRole('heading', { level: 1, name: oldHeading })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'På denne siden' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: newSection })).toBeNull();
    expect((previewSwitch() as HTMLInputElement).checked).toBe(false);
  });

  it('switches to the new start page and remembers the choice after a reload', async () => {
    renderSignedOut();

    fireEvent.click(previewSwitch());

    expect(await screen.findByRole('heading', { level: 2, name: newSection })).toBeTruthy();
    expect((previewSwitch() as HTMLInputElement).checked).toBe(true);
    expect(window.localStorage.getItem(landingStorageKey)).toBe('new');

    cleanup();
    renderSignedOut();

    expect(await screen.findByRole('heading', { level: 2, name: newSection })).toBeTruthy();
  });

  it('switches back to the old start page and remembers that too', async () => {
    window.localStorage.setItem(landingStorageKey, 'new');
    renderSignedOut();

    fireEvent.click(await screen.findByRole('switch', { name: 'Ny startside (forhåndsvisning)' }));

    expect(screen.getByRole('navigation', { name: 'På denne siden' })).toBeTruthy();
    expect(window.localStorage.getItem(landingStorageKey)).toBe('old');
  });

  it('opens the new start page from ?landing=new in the address and keeps it', async () => {
    window.location.hash = '#/?landing=new';
    renderSignedOut();

    expect(await screen.findByRole('heading', { level: 2, name: newSection })).toBeTruthy();
    expect(window.localStorage.getItem(landingStorageKey)).toBe('new');
  });

  it('opens the old start page from ?landing=old even after the new one was chosen', () => {
    window.localStorage.setItem(landingStorageKey, 'new');
    window.location.hash = '#/?landing=old';
    renderSignedOut();

    expect(screen.getByRole('navigation', { name: 'På denne siden' })).toBeTruthy();
  });

  it('falls back to the old start page when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderSignedOut();

    fireEvent.click(previewSwitch());

    expect((previewSwitch() as HTMLInputElement).checked).toBe(true);
  });

  it('leaves signed-in users in the portal whatever the choice or the address says', async () => {
    window.localStorage.setItem(landingStorageKey, 'new');
    await renderAt('/?landing=new');

    expect(
      await screen.findByRole('button', {
        name: 'Handler for Testetaten, org.nr. 999 888 777. Bytt virksomhet',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('heading', { name: newSection })).toBeNull();
  });

  it('logs in from the new start page into the portal', async () => {
    window.localStorage.setItem(landingStorageKey, 'new');
    renderSignedOut();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Logg inn' }))[0] as HTMLElement);

    expect(
      await screen.findByRole('button', {
        name: 'Handler for Testetaten, org.nr. 999 888 777. Bytt virksomhet',
      }),
    ).toBeTruthy();
  });
});
