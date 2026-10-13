// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectAccessible } from '../test-utils';
import { Startside } from './Startside';

afterEach(cleanup);

describe('Startside', () => {
  it('presents the platform with the facts, sections and section anchors', () => {
    render(<Startside onLogin={() => undefined} busy={false} failed={false} />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Generativ KI for offentlige virksomheter, drevet av Digdir',
      }),
    ).toBeTruthy();
    const anchors = screen.getByRole('navigation', { name: 'På denne siden' });
    expect(
      within(anchors)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Fellestjenester', 'Eksempler', 'Pris og vilkår', 'Data', 'Dokumentasjon']);
    for (const name of [
      'Hva plattformen gjør',
      'Fellestjenester',
      'Tre eksempler',
      'Pris',
      'Slik behandles data',
      'Kom i gang',
      'Dokumentasjon',
    ])
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    expectAccessible();
  });

  it('claims no residency or prices the platform cannot back up', () => {
    render(<Startside onLogin={() => undefined} busy={false} failed={false} />);

    expect(screen.getAllByText('Ikke bestemt')).toHaveLength(3);
    expect(screen.queryByRole('table')).toBeNull();
    const page = document.body.textContent ?? '';
    expect(page).not.toMatch(/I Norge eller i EU|Borealis|AIVAR|datasentre i EU|EU \(Sverige\)/);
    expect(page).toContain('I dag kjører modellene i Azure med global behandling');
    expect(screen.getByText('Prisene per modell er ikke bestemt ennå.')).toBeTruthy();
  });

  it('says Digdir can change setup in a support session but never makes API keys', () => {
    render(<Startside onLogin={() => undefined} busy={false} failed={false} />);

    const page = document.body.textContent ?? '';
    expect(page).toContain('I en støtteøkt kan Digdir endre oppsettet på vegne av virksomheten.');
    expect(page).toContain('«Endring fra Digdir»');
    expect(page).toContain('Digdir lager aldri API-nøkler for virksomheten.');
    expect(page).not.toMatch(/kun lesing|bare lesing/i);
  });

  it('links terms and data handling to the data-handling page, not to missing pages', () => {
    render(<Startside onLogin={() => undefined} busy={false} failed={false} />);

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).not.toContain('#/terms');
    expect(hrefs).not.toContain('#/dpa');
    expect(screen.getByRole('link', { name: 'Slik behandles data' }).getAttribute('href')).toBe(
      '#/data-handling',
    );
    expect(
      screen.getByRole('link', { name: 'Les mer om hvordan data behandles' }).getAttribute('href'),
    ).toBe('#/data-handling');
  });

  it('keeps the hash route when jumping to a section', () => {
    window.location.hash = '';
    render(<Startside onLogin={() => undefined} busy={false} failed={false} />);

    fireEvent.click(screen.getAllByRole('link', { name: 'Fellestjenester' })[0] as HTMLElement);

    expect(window.location.hash).toBe('');
    expect(document.activeElement?.id).toBe('fellestjenester');
  });

  it('explains the steps from the access request to the first service in Kom i gang', () => {
    render(<Startside onLogin={() => undefined} busy={false} failed={false} />);

    const start = screen.getByRole('region', { name: 'Kom i gang' });
    expect(
      within(start)
        .getAllByRole('heading', { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      'Be om tilgang',
      'Digdir godkjenner',
      'Første administrator logger inn',
      'Lag den første tjenesten',
    ]);
    expect(within(start).getByText(/Vilkårene er ikke bestemt ennå/)).toBeTruthy();
  });

  it('logs in from the header and from Send forespørsel', () => {
    const onLogin = vi.fn();
    render(<Startside onLogin={onLogin} busy={false} failed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send forespørsel' }));

    expect(onLogin).toHaveBeenCalledTimes(2);
  });

  it('shows a menu toggle on narrow screens', () => {
    const width = window.innerWidth;
    window.innerWidth = 600;
    render(<Startside onLogin={() => undefined} busy={false} failed={false} />);

    const toggle = screen.getByRole('button', { name: 'Meny' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(screen.getByRole('navigation', { name: 'På denne siden' })).getByText('Kom i gang'),
    ).toBeTruthy();
    window.innerWidth = width;
  });
});
