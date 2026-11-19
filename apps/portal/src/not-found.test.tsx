// @vitest-environment jsdom
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guessArea } from './signed-in-page';
import { renderAt } from './test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Fant ikke siden', () => {
  it.each([
    ['dataset', '/datasets'],
    ['statistikk', '/statistics'],
    ['tilgnag', '/access'],
    ['servics', '/services'],
  ])('guesses the menu item the address %s most likely meant', (area, path) => {
    expect(guessArea(area)?.path).toBe(path);
  });

  it('makes no guess for an address unlike any menu item', () => {
    expect(guessArea('xyzzy')).toBeUndefined();
    expect(guessArea('ab')).toBeUndefined();
  });

  it('offers Gå til the guessed area first, then Oversikt', async () => {
    await renderAt('#/statistikk');

    await screen.findByRole('heading', { level: 1, name: 'Fant ikke siden' });
    const guess = screen.getByRole('link', { name: 'Gå til Statistikk' });
    expect(guess.getAttribute('href')).toBe('#/statistics');
    expect(screen.getByRole('link', { name: 'Gå til Oversikt' })).toBeTruthy();
  });
});
