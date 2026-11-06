// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsLinks } from './SettingsLinks.js';

afterEach(cleanup);
// jsdom cannot follow a link the block left to the browser, and says so.
const stayOnPage = (event: Event) => event.preventDefault();
document.addEventListener('click', stayOnPage);

const pages = [
  { href: '/onboarding', title: 'Onboarding' },
  { href: '/endringslogg', title: 'Endringslogg' },
  { href: '/om-prosjektet', title: 'Om prosjektet' },
];

describe('the links in the panel’s foot', () => {
  it('put «Innstillinger» first, then the host’s pages, in a list named for both', () => {
    render(
      <SettingsLinks
        settingsHref="/innstillinger"
        links={pages}
        assistantName="Kunnskapsassistenten"
      />,
    );
    const list = screen.getByRole('list', { name: 'Innstillinger og om Kunnskapsassistenten' });
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Innstillinger', 'Onboarding', 'Endringslogg', 'Om prosjektet']);
    expect(screen.getByRole('link', { name: 'Innstillinger' }).getAttribute('href')).toBe(
      '/innstillinger',
    );
  });

  it('are a named list, not a second navigation landmark inside the panel', () => {
    render(<SettingsLinks settingsHref="/innstillinger" links={pages} />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('list', { name: 'Innstillinger og om tjenesten' })).toBeTruthy();
  });

  it('are named «Innstillinger» alone when there is nothing else', () => {
    render(<SettingsLinks settingsHref="/innstillinger" />);
    expect(screen.getByRole('list', { name: 'Innstillinger' })).toBeTruthy();
  });

  it('mark the page on screen with aria-current', () => {
    render(
      <SettingsLinks settingsHref="/innstillinger" links={pages} currentHref="/innstillinger" />,
    );
    expect(screen.getByRole('link', { name: 'Innstillinger' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Onboarding' }).hasAttribute('aria-current')).toBe(
      false,
    );
  });

  it('give a plain click to the host’s router, and leave a click for a new tab to the browser', () => {
    const onNavigate = vi.fn();
    render(<SettingsLinks settingsHref="/innstillinger" links={pages} onNavigate={onNavigate} />);
    const link = screen.getByRole('link', { name: 'Endringslogg' });
    fireEvent.click(link, { ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('/endringslogg');
  });

  it('hide the cog from a screen reader, which reads the title', () => {
    render(<SettingsLinks settingsHref="/innstillinger" />);
    const icon = screen.getByRole('link', { name: 'Innstillinger' }).querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });
});
