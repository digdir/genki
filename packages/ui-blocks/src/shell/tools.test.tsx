// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellTools, type ShellTool } from './Tools.js';

afterEach(cleanup);

const tool = (id: string, label: string): ShellTool => ({
  id,
  label,
  content: <p>Innholdet i {label}</p>,
});
const sources = tool('sources', 'Kilder');
const approach = tool('approach', 'Fremgangsmåte');
const notes = tool('notes', 'Notater');

describe('the secondary panel’s tools', () => {
  it('draws nothing without a tool', () => {
    const { container } = render(<ShellTools tools={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('names one tool with a heading, and offers no choice', () => {
    render(<ShellTools tools={[sources]} headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Kilder' })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Innholdet i Kilder').closest('[hidden]')).toBeNull();
  });

  it('offers two tools as tabs, the first chosen, the other’s content hidden but kept', () => {
    render(<ShellTools tools={[approach, sources]} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Fremgangsmåte', 'Kilder']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Fremgangsmåte' }).closest('[hidden]')).toBeNull();
    expect(
      screen.getByText('Innholdet i Kilder', { selector: 'p' }).closest('[hidden]'),
    ).not.toBeNull();
  });

  it('gives the tabs one tab stop, and lets the arrows, Home and End choose', () => {
    render(<ShellTools tools={[approach, sources]} />);
    const [first, second] = screen.getAllByRole('tab') as [HTMLElement, HTMLElement];
    expect(first.getAttribute('tabindex')).toBe('0');
    expect(second.getAttribute('tabindex')).toBe('-1');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(second.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Home' });
    expect(first.getAttribute('aria-selected')).toBe('true');
  });

  it('offers three tools or more in a dropdown named «Verktøy»', () => {
    render(<ShellTools tools={[approach, sources, notes]} />);
    const choice = screen.getByRole('combobox', { name: 'Verktøy' });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Fremgangsmåte',
      'Kilder',
      'Notater',
    ]);
    fireEvent.change(choice, { target: { value: 'notes' } });
    expect(screen.getByRole('region', { name: 'Notater' }).closest('[hidden]')).toBeNull();
    expect(
      screen.getByText('Innholdet i Kilder', { selector: 'p' }).closest('[hidden]'),
    ).not.toBeNull();
  });

  it('follows the tool the app chooses, as when a footnote asks for the sources', () => {
    const Host = () => {
      const [active, setActive] = useState('approach');
      return (
        <>
          <button type="button" onClick={() => setActive('sources')}>
            Fotnote 1
          </button>
          <ShellTools tools={[approach, sources]} value={active} onChange={setActive} />
        </>
      );
    };
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Fotnote 1' }));
    expect(screen.getByRole('tab', { name: 'Kilder' }).getAttribute('aria-selected')).toBe('true');
  });

  it('reports the reader’s choice, and not a choice of the tool already shown', () => {
    const chosen: string[] = [];
    render(<ShellTools tools={[approach, sources]} onChange={(id) => chosen.push(id)} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Fremgangsmåte' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Kilder' }));
    expect(chosen).toEqual(['sources']);
  });

  it('falls back to the first tool when the chosen one is gone', () => {
    render(<ShellTools tools={[approach, sources]} value="notes" />);
    expect(screen.getByRole('tab', { name: 'Fremgangsmåte' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});

describe('the switcher pinned in the panel', () => {
  it('draws the tabs in the region it is given, and the tools where they stand', () => {
    const region = document.createElement('div');
    document.body.append(region);
    render(<ShellTools tools={[approach, sources]} pinIn={region} />);
    expect(region.querySelector('[role="tablist"]')).not.toBeNull();
    expect(region.textContent).not.toContain('Innholdet i');
    region.remove();
  });

  it('draws no switcher while the region is not there yet', () => {
    render(<ShellTools tools={[approach, sources]} pinIn={null} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('Innholdet i Fremgangsmåte')).toBeTruthy();
  });
});

describe('the tinted switcher, the dev boards’', () => {
  const withIcon = (one: ShellTool): ShellTool => ({ ...one, icon: <svg data-icon={one.id} /> });

  it('offers two tools as joined buttons with their icons, the tabs pattern kept (dev-verktoy-2)', () => {
    render(<ShellTools tools={[approach, sources].map(withIcon)} variant="tinted" />);
    const tablist = screen.getByRole('tablist', { name: 'Verktøy' });
    expect(tablist.getAttribute('data-variant')).toBe('tinted');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Fremgangsmåte', 'Kilder']);
    expect(tabs.map((tab) => tab.querySelector('svg')?.getAttribute('data-icon'))).toEqual([
      'approach',
      'sources',
    ]);
    fireEvent.click(screen.getByRole('tab', { name: 'Kilder' }));
    expect(screen.getByRole('tabpanel', { name: 'Kilder' }).closest('[hidden]')).toBeNull();
  });

  it('offers three or more as a button named by the tool shown, which opens a menu of them (dev-verktoy-3)', () => {
    const chosen: string[] = [];
    render(
      <ShellTools
        tools={[approach, sources, notes].map(withIcon)}
        variant="tinted"
        onChange={(id) => chosen.push(id)}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Fremgangsmåte, velg verktøy' });
    expect(trigger.textContent).toBe('Fremgangsmåte');
    const menu = document.querySelector<HTMLElement>('.uib-shell-tools-menu');
    const entries = [...(menu?.querySelectorAll('button') ?? [])];
    expect(entries.map((entry) => entry.textContent)).toEqual([
      'Fremgangsmåte',
      'Kilder',
      'Notater',
    ]);
    expect(entries.map((entry) => entry.getAttribute('aria-current'))).toEqual([
      'true',
      null,
      null,
    ]);
    fireEvent.click(entries[2] as HTMLElement);
    expect(chosen).toEqual(['notes']);
    expect(screen.getByRole('button', { name: 'Notater, velg verktøy' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Notater' }).closest('[hidden]')).toBeNull();
  });
});
