// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourcesArea } from './setup-area-views';

afterEach(cleanup);

const catalogue = [
  { id: 'digdir/arsrapporter', name: 'Årsrapporter', shared: false },
  { id: 'digdir/kudos', name: 'Kudos-rapporter', shared: false },
  { id: 'digdir/tildelingsbrev', name: 'Tildelingsbrev', shared: false },
];

const clear = () => document.querySelector('button[aria-label="Fjern alle dokumentsamlinger"]');

const area = (readOnly: boolean, onSet = vi.fn()) => {
  render(
    <SourcesArea
      chosen={['digdir/tildelingsbrev', 'digdir/arsrapporter']}
      options={{ status: 'ready', data: catalogue }}
      readOnly={readOnly}
      nameOf={(id) => id}
      onSet={onSet}
    />,
  );
  return onSet;
};

describe('the Dokumentsamlinger picker in Oppsett', () => {
  it('keeps the chosen order and adds a picked collection last', async () => {
    const onSet = area(false);
    const datasets = screen.getByRole('combobox', { name: 'Dokumentsamlinger' });
    fireEvent.focus(datasets);
    fireEvent.click(datasets);
    fireEvent.input(datasets, { target: { value: 'Kudos' } });
    // jsdom has no popover support, so the open list counts as hidden to the accessibility tree.
    fireEvent.click(await screen.findByRole('option', { name: 'Kudos-rapporter', hidden: true }));
    expect(onSet).toHaveBeenLastCalledWith([
      'digdir/tildelingsbrev',
      'digdir/arsrapporter',
      'digdir/kudos',
    ]);
  });

  it('offers Fjern alle dokumentsamlinger only when the Oppsett can be changed', () => {
    area(false);
    // Designsystemet renders the button with hidden in jsdom, so it is found by its label.
    expect(clear()).toBeTruthy();
    cleanup();
    area(true);
    expect(clear()).toBeNull();
  });
});
