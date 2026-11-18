// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceNav } from './ServiceNav';

afterEach(cleanup);

const renderNav = () =>
  render(<ServiceNav id="rapport" sections={['overview', 'setup', 'quality']} current="setup" />);

const link = (name: string) => screen.getByRole('link', { name });

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
});
