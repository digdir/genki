// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nb as sharedNb } from '../i18n.js';
import { colorSchemes, isColorScheme, type ColorScheme } from './colorScheme.js';
import { en, nb } from './i18n.js';
import { ColorSchemeToggle, Settings, SettingsSection, type SettingsProps } from './Settings.js';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-color-scheme');
});

const draw = (props: Partial<SettingsProps> = {}) => {
  const onColorSchemeChange = vi.fn<(scheme: ColorScheme) => void>();
  const view = render(<Settings onColorSchemeChange={onColorSchemeChange} {...props} />);
  return { ...view, onColorSchemeChange };
};

const radio = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });
const checked = () =>
  screen.getAllByRole<HTMLInputElement>('radio').filter((input) => input.checked);

describe('the colour scheme choice', () => {
  it('is a group of three named «Fargemodus», with words beside the icons', () => {
    draw();
    const group = screen.getByRole('group', { name: 'Fargemodus' });
    const items = within(group).getAllByRole('radio');
    expect(items.map((item) => item.closest('label')?.textContent)).toEqual([
      'Lys',
      'Mørk',
      'Auto',
    ]);
    for (const item of items)
      expect(item.closest('label')?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('stands on «Auto» until the host says otherwise', () => {
    draw();
    expect(checked()).toEqual([radio('Auto')]);
  });

  it('reports the choice, and can go back to «Auto», which is why it is not a switch', () => {
    const { onColorSchemeChange, rerender } = draw();
    fireEvent.click(radio('Mørk'));
    expect(onColorSchemeChange).toHaveBeenLastCalledWith('dark');

    rerender(<Settings colorScheme="dark" onColorSchemeChange={onColorSchemeChange} />);
    fireEvent.click(radio('Auto'));
    expect(onColorSchemeChange).toHaveBeenLastCalledWith('auto');
  });

  it('leaves storing and applying the choice to the host', () => {
    draw();
    fireEvent.click(radio('Mørk'));
    expect(document.documentElement.hasAttribute('data-color-scheme')).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('shows the host’s value, not the click, until the host takes the choice', () => {
    draw({ colorScheme: 'light' });
    fireEvent.click(radio('Mørk'));
    expect(checked()).toEqual([radio('Lys')]);
  });

  it('shows a choice the host made elsewhere, such as in another tab', () => {
    const { onColorSchemeChange, rerender } = draw({ colorScheme: 'dark' });
    rerender(<Settings colorScheme="light" onColorSchemeChange={onColorSchemeChange} />);
    expect(checked()).toEqual([radio('Lys')]);
    expect(onColorSchemeChange).not.toHaveBeenCalled();
  });

  it('treats a value it does not know as «Auto»', () => {
    draw({ colorScheme: 'neon' as ColorScheme });
    expect(checked()).toEqual([radio('Auto')]);
  });

  it('can stand on its own, for a host that places it elsewhere', () => {
    const onChange = vi.fn();
    render(<ColorSchemeToggle value="dark" onChange={onChange} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(checked()).toEqual([radio('Mørk')]);
    fireEvent.click(radio('Lys'));
    expect(onChange).toHaveBeenCalledWith('light');
  });
});

describe('the settings block', () => {
  it('is headed «Innstillinger», with the colour scheme in a section one level below', () => {
    draw();
    expect(screen.getByRole('heading', { level: 2, name: 'Innstillinger' })).toBeTruthy();
    const section = screen.getByRole('region', { name: 'Fargemodus' });
    expect(within(section).getByRole('heading', { level: 3, name: 'Fargemodus' })).toBeTruthy();
    expect(within(section).getByRole('group', { name: 'Fargemodus' })).toBeTruthy();
  });

  it('takes its heading level from the host, as on a page of its own', () => {
    draw({ headingLevel: 1 });
    expect(screen.getByRole('heading', { level: 1, name: 'Innstillinger' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Fargemodus' })).toBeTruthy();
  });

  it('puts the host’s own sections after the colour scheme, headed at the same level', () => {
    draw({
      headingLevel: 1,
      children: (
        <SettingsSection title="Svar">
          <p>Vis fremgangsmåten</p>
        </SettingsSection>
      ),
    });
    expect(screen.getAllByRole('region').map((region) => region.textContent)).toEqual([
      'FargemodusLysMørkAuto',
      'SvarVis fremgangsmåten',
    ]);
    expect(screen.getByRole('heading', { level: 2, name: 'Svar' })).toBeTruthy();
  });

  it('follows the host’s colour family unless the host gives one', () => {
    const { container, rerender, onColorSchemeChange } = draw();
    const root = () => container.querySelector('.uib-settings');
    expect(root()?.hasAttribute('data-color')).toBe(false);
    rerender(<Settings color="brand1" onColorSchemeChange={onColorSchemeChange} />);
    expect(root()?.getAttribute('data-color')).toBe('brand1');
  });

  it('never sets a colour scheme of its own, so it follows the host’s', () => {
    const { container } = draw({ colorScheme: 'dark' });
    expect(container.querySelector('[data-color-scheme]')).toBeNull();
  });

  it('speaks English when the person does', () => {
    render(
      <InLocale locale="en">
        <Settings onColorSchemeChange={() => {}} />
      </InLocale>,
    );
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Colour scheme' })).toBeTruthy();
    expect(screen.getAllByRole('radio').map((item) => item.closest('label')?.textContent)).toEqual([
      'Light',
      'Dark',
      'Auto',
    ]);
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it("keeps the settings' words in their own catalogue, out of the shared one that Approach loads", () => {
    expect(Object.keys(nb)).toEqual(['settings']);
    expect(sharedNb).not.toHaveProperty('settings');
  });
});

describe('the colour schemes', () => {
  it('are Designsystemet’s three, and a stored value that is not one is no choice', () => {
    expect(colorSchemes).toEqual(['light', 'dark', 'auto']);
    for (const scheme of colorSchemes) expect(isColorScheme(scheme)).toBe(true);
    for (const value of ['neon', 'system', '', null, undefined, 1])
      expect(isColorScheme(value)).toBe(false);
  });
});
