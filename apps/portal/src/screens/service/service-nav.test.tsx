// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceNav, ServiceSubNav } from './ServiceNav';

afterEach(cleanup);

const renderNav = () =>
  render(
    <ServiceNav
      id="rapport"
      name="Rapportassistenten"
      sections={['overview', 'setup', 'quality']}
      current="setup"
    />,
  );

const link = (name: string) => screen.getByRole('tab', { name });

describe('the service tab bar', () => {
  it('moves the focus to the next and previous tab with the arrow keys, wrapping at the ends', () => {
    renderNav();
    link('Oppsett').focus();

    fireEvent.keyDown(link('Oppsett'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(link('Kvalitet'));
    fireEvent.keyDown(link('Kvalitet'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(link('Oversikt'));
    fireEvent.keyDown(link('Oversikt'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(link('Kvalitet'));
  });

  it('moves the focus to the first and last tab with Home and End', () => {
    renderNav();
    link('Oppsett').focus();

    fireEvent.keyDown(link('Oppsett'), { key: 'End' });
    expect(document.activeElement).toBe(link('Kvalitet'));
    fireEvent.keyDown(link('Kvalitet'), { key: 'Home' });
    expect(document.activeElement).toBe(link('Oversikt'));
  });

  it('names the tab bar after the service, so its tabs are told apart from the sidebar links', () => {
    renderNav();

    expect(screen.getByRole('tablist', { name: 'Faner for Rapportassistenten' })).toBeTruthy();
    expect(link('Oppsett').getAttribute('aria-selected')).toBe('true');
  });
});

describe('the Utviklerverktøy side menu', () => {
  it('moves the focus between its tabs with the up and down arrow keys', () => {
    render(
      <ServiceSubNav
        id="rapport"
        sections={['versions', 'log', 'channels', 'environments', 'batch', 'definition']}
        current="log"
      />,
    );
    const menu = screen.getByRole('tablist', { name: 'Utviklerverktøy' });
    expect(menu.getAttribute('aria-orientation')).toBe('vertical');
    const tab = (name: string) => screen.getByRole('tab', { name });
    tab('Logg').focus();

    fireEvent.keyDown(tab('Logg'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tab('Nøkler og kanaler'));
    fireEvent.keyDown(tab('Nøkler og kanaler'), { key: 'ArrowUp' });
    fireEvent.keyDown(tab('Logg'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(tab('Versjoner'));
    fireEvent.keyDown(tab('Versjoner'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(tab('Definisjon (YAML)'));
  });
});
