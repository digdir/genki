// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialsOf, ShellProfile, type ShellProfileProps } from './Profile.js';

// The reader at the primary panel's foot and the profile menu, as the design's dev-navbar and
// dev-innstillinger-0-start boards draw them.

document.getAnimations ??= () => [];
afterEach(cleanup);

const name = 'Kari Marie Nordmann';
const draw = (props: Partial<ShellProfileProps> = {}) =>
  render(<ShellProfile name={name} {...props} />);

const trigger = () => screen.getByRole('button', { name });
const menu = () => document.querySelector<HTMLElement>('.uib-shell-profile-menu');
/** The menu's entries in order, each by the words it shows. */
const entries = () =>
  [...(menu()?.querySelectorAll('li .uib-shell-profile-label') ?? [])].map((e) => e.textContent);

const everything: Partial<ShellProfileProps> = {
  organisation: 'Digitaliseringsdirektoratet',
  settings: { href: '/innstillinger' },
  feedback: { onSelect: () => {} },
  changelog: { href: '/endringslogg' },
  about: { href: '/om' },
  contact: { href: 'mailto:post@digdir.no', to: 'Digdir' },
  signOut: { href: '/logg-ut' },
};

describe('the profile at the panel’s foot', () => {
  it('draws nothing without a name to show', () => {
    const { container } = render(<ShellProfile settings={{ href: '/innstillinger' }} />);
    expect(container.innerHTML).toBe('');
  });

  it('is one button named and titled by the whole name, with the initials on an accent avatar', () => {
    draw();
    expect(trigger().getAttribute('title')).toBe(name);
    expect(trigger().getAttribute('data-variant')).toBe('tertiary');
    expect(trigger().getAttribute('data-color')).toBe('neutral');
    const avatar = trigger().querySelector('.ds-avatar');
    expect(avatar?.textContent).toBe('KN');
    expect(avatar?.getAttribute('data-size')).toBe('xs');
    expect(avatar?.getAttribute('data-color')).toBe('accent');
    expect(trigger().querySelector('.uib-shell-profile-name')?.textContent).toBe(name);
  });

  it('has no cog: settings are in the menu, and the button holds only the avatar and the name', () => {
    draw(everything);
    expect(trigger().querySelectorAll('svg')).toHaveLength(0);
    expect(screen.getAllByRole('button', { name })).toHaveLength(1);
  });

  it('shows only the avatar on a rail, still named by the whole name', () => {
    draw({ compact: true });
    expect(trigger().classList.contains('uib-shell-profile-rail')).toBe(true);
    expect(trigger().querySelector('.uib-shell-profile-name')).toBeNull();
    expect(trigger().textContent).toBe('KN');
  });
});

describe('the profile menu', () => {
  it('opens from the button, above it', () => {
    draw(everything);
    expect(menu()?.getAttribute('data-placement')).toBe('top-start');
    expect(trigger().getAttribute('popovertarget')).toBe(menu()?.id);
  });

  it('has the design’s entries in its order, «Logg ut» last under a line', () => {
    draw(everything);
    expect(entries()).toEqual([
      'Innstillinger',
      'Gi tilbakemelding',
      'Endringslogg',
      'Om tjenesten',
      'Kontakt Digdir',
      'Logg ut',
    ]);
    const lists = menu()?.querySelectorAll('ul') ?? [];
    expect(lists).toHaveLength(2);
    expect(lists[1]?.previousElementSibling?.tagName).toBe('HR');
    expect(lists[1]?.textContent).toBe('Logg ut');
  });

  it('draws only the entries the host gives, and no line without any', () => {
    draw({ settings: { href: '/innstillinger' }, signOut: { href: '/logg-ut' } });
    expect(entries()).toEqual(['Innstillinger', 'Logg ut']);
    cleanup();
    draw({ signOut: { href: '/logg-ut' } });
    expect(entries()).toEqual(['Logg ut']);
    expect(menu()?.querySelector('hr')).toBeNull();
  });

  it('puts the avatar, the name and the organisation at the top, the organisation only when given', () => {
    draw(everything);
    const who = menu()?.querySelector('.uib-shell-profile-who');
    expect(who?.querySelector('.ds-avatar')?.getAttribute('data-size')).toBe('sm');
    expect(who?.textContent).toBe(`KN${name}Digitaliseringsdirektoratet`);
    cleanup();
    draw();
    expect(menu()?.querySelector('.uib-shell-profile-who-organisation')).toBeNull();
  });

  it('marks «Endringslogg» with a dot only when the host says something is new, in words too', () => {
    draw({ changelog: { href: '/endringslogg' } });
    expect(menu()?.querySelector('.uib-shell-profile-news')).toBeNull();
    cleanup();
    draw({ changelog: { href: '/endringslogg', news: true } });
    const dot = menu()?.querySelector('.uib-shell-profile-news');
    expect(dot?.textContent).toBe('Nytt');
    expect(dot?.getAttribute('data-color')).toBe('accent');
  });

  it('hands a plain click on a link to the host, and leaves one for a new tab to the browser', () => {
    const onSelect = vi.fn();
    draw({ settings: { href: '/innstillinger', onSelect } });
    const link = within(menu() as HTMLElement).getByRole('link', {
      name: 'Innstillinger',
      hidden: true,
    });
    expect(fireEvent.click(link)).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('runs an action without an address, as a button', () => {
    const onSelect = vi.fn();
    draw({ feedback: { onSelect } });
    fireEvent.click(
      within(menu() as HTMLElement).getByRole('button', {
        name: 'Gi tilbakemelding',
        hidden: true,
      }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('draws the host’s own entries in its words and order, after the menu’s pages and before «Logg ut»', () => {
    draw({
      ...everything,
      extra: [
        { id: 'old', label: 'Tilbake til gammel versjon', href: '/gammel' },
        { id: 'help', label: 'Hjelp', onSelect: () => {} },
      ],
    });
    expect(entries()).toEqual([
      'Innstillinger',
      'Gi tilbakemelding',
      'Endringslogg',
      'Om tjenesten',
      'Kontakt Digdir',
      'Tilbake til gammel versjon',
      'Hjelp',
      'Logg ut',
    ]);
    const lists = menu()?.querySelectorAll('ul') ?? [];
    expect(lists[1]?.textContent).toBe('Logg ut');
  });

  it('leads a host’s entry where it says, hands it a plain click, and leaves out one with nowhere to go', () => {
    const onSelect = vi.fn();
    draw({
      extra: [
        { id: 'old', label: 'Tilbake til gammel versjon', href: '/gammel', onSelect },
        { id: 'nothing', label: 'Ingenting' },
      ],
    });
    expect(entries()).toEqual(['Tilbake til gammel versjon']);
    const link = within(menu() as HTMLElement).getByRole('link', {
      name: 'Tilbake til gammel versjon',
      hidden: true,
    });
    expect(link.getAttribute('href')).toBe('/gammel');
    expect(fireEvent.click(link)).toBe(false);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('keeps a host’s icon out of the entry’s name', () => {
    draw({
      extra: [
        {
          id: 'old',
          label: 'Tilbake til gammel versjon',
          href: '/gammel',
          icon: <svg data-testid="old-icon" aria-label="Pil" />,
        },
      ],
    });
    const link = within(menu() as HTMLElement).getByRole('link', {
      name: 'Tilbake til gammel versjon',
      hidden: true,
    });
    expect(screen.getByTestId('old-icon').closest('[aria-hidden="true"]')).toBeTruthy();
    expect(link.querySelector('.uib-shell-profile-icon')).toBeTruthy();
  });

  it('keeps a host’s entry apart from the menu’s own, even under the same id', () => {
    const warned = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      draw({
        settings: { href: '/innstillinger' },
        extra: [{ id: 'settings', label: 'Mine innstillinger', href: '/mine' }],
      });
      expect(entries()).toEqual(['Innstillinger', 'Mine innstillinger']);
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it('lets the host forget the reader on «Logg ut», and follows the link to sign out', () => {
    const onSignOut = vi.fn();
    draw({ signOut: { href: '/logg-ut', onSignOut } });
    const link = within(menu() as HTMLElement).getByRole('link', { name: 'Logg ut', hidden: true });
    expect(link.getAttribute('href')).toBe('/logg-ut');
    expect(fireEvent.click(link)).toBe(true);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('is pinned to neutral, as the panel’s chrome', () => {
    draw(everything);
    expect(menu()?.getAttribute('data-color')).toBe('neutral');
  });
});

describe('the initials', () => {
  it('are the first and the last word’s first letters, in capitals', () => {
    expect(initialsOf('Kari Marie Nordmann')).toBe('KN');
    expect(initialsOf('øystein ås')).toBe('ØÅ');
    expect(initialsOf('Testidentitet: ka-ui-blocks-preview')).toBe('TK');
    expect(initialsOf('Kari')).toBe('K');
  });
});
