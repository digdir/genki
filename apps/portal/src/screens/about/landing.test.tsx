// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch } from '../../mock';
import { kari, renderAt } from '../../test-utils';

const landingHeading = 'Genki: generativ KI for offentlige virksomheter';
const architecture = 'Slik er Genki tenkt';

const renderSignedOut = () => render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} />);

beforeEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
});
afterEach(cleanup);

describe('landing', () => {
  it('shows the landing with the map of how genki is built at the root, with no switch', async () => {
    renderSignedOut();

    expect(await screen.findByRole('heading', { level: 2, name: architecture })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: landingHeading })).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('shows the same landing for an old preview address and a stored old choice', async () => {
    window.localStorage.setItem('genki:landing', 'old');
    window.location.hash = '#/?landing=old';
    renderSignedOut();

    expect(await screen.findByRole('heading', { level: 2, name: architecture })).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('points every link in the landing at a page the public site shows', async () => {
    renderSignedOut();
    await screen.findByRole('heading', { level: 2, name: architecture });
    const targets = [
      ...new Set(
        within(screen.getByRole('main'))
          .getAllByRole('link')
          .flatMap((a) => a.getAttribute('href') ?? []),
      ),
    ];
    const internal = targets.filter((to) => to.startsWith('#/'));
    expect(internal.length).toBeGreaterThan(0);
    for (const to of targets.filter((t) => t.startsWith('#') && !t.startsWith('#/')))
      expect(document.getElementById(to.slice(1)), to).toBeTruthy();
    for (const to of targets.filter((t) => !t.startsWith('#')))
      expect(to, to).toMatch(/^https:\/\/github\.com\/digdir\/genki(\/|$)/);
    cleanup();

    for (const to of internal) {
      window.location.hash = to;
      renderSignedOut();
      const heading = await screen.findByRole('heading', { level: 1 });
      expect(heading.textContent, to).not.toBe(landingHeading);
      expect(heading.textContent, to).not.toBe('Fant ikke siden');
      cleanup();
    }
  });

  it('leaves signed-in users in the portal whatever the address says', async () => {
    await renderAt('/?landing=new');

    expect(
      await screen.findByRole('button', {
        name: 'Brukermeny for Kari Nordmann, Testetaten',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: architecture })).toBeNull();
  });

  it('logs in from the landing into the portal', async () => {
    renderSignedOut();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Logg inn' }))[0] as HTMLElement);

    expect(
      await screen.findByRole('button', {
        name: 'Brukermeny for Kari Nordmann, Testetaten',
      }),
    ).toBeTruthy();
  });
});
