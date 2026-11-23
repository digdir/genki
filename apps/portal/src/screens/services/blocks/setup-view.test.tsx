// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { defaultLayout, type AssistantLayout } from '@genai/ui-blocks/builder';
import { afterEach, describe, expect, it } from 'vitest';
import { BlocksStep, useBlocksState } from './BlocksStep';

document.getAnimations ??= () => [];

afterEach(cleanup);

const Harness = ({ start }: { start: AssistantLayout }) => (
  <BlocksStep
    state={useBlocksState(() => ({ layout: start }))}
    narrow={false}
    run={undefined}
    address="ny-tjeneste.genki.no"
    onFullscreen={() => undefined}
  />
);

const setupView = (start: AssistantLayout = defaultLayout) => {
  render(<Harness start={start} />);
  fireEvent.click(screen.getByRole('radio', { name: 'Plasser' }));
};

const frame = () => document.querySelector('.service-preview-frame') as HTMLElement;
const removeButtons = () =>
  within(frame())
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'));

/** Takes the block out with its «Fjern», as the keyboard does: focus, then press. */
const remove = (name: string) =>
  act(() => {
    const button = within(frame()).getByRole('button', { name });
    button.focus();
    fireEvent.click(button);
  });

const switchIn = (group: string, name: string) =>
  within(screen.getByRole('group', { name: group })).getByRole('switch', {
    name,
  }) as HTMLInputElement;

/** Fremgangsmåte in the content and the right panel, in Oppsett. */
const inTwoPanels = () => {
  render(<Harness start={defaultLayout} />);
  fireEvent.click(switchIn('Høyre', 'Fremgangsmåte'));
  fireEvent.click(screen.getByRole('radio', { name: 'Plasser' }));
};

describe('«Fjern» in the preview’s Oppsett', () => {
  it('moves the focus to the next block’s «Fjern» when a block is taken out', async () => {
    setupView();
    const [first, second] = removeButtons();
    await remove(first ?? '');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(second);
  });

  it('moves the focus to the «Fjern» before it when the last block in the preview is taken out', async () => {
    setupView();
    const names = removeButtons();
    await remove(names.at(-1) ?? '');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(names.at(-2));
  });

  it('moves the focus to what the preview says when no block is left', async () => {
    setupView({ version: 1, zones: { primary: [], main: [{ block: 'chat' }], secondary: [] } });
    await remove('Fjern Samtale');
    expect(document.activeElement?.textContent).toBe(
      'Slå på designelementer for å se tjenesten her.',
    );
  });

  it('names each «Fjern» of a block that stands in two panels by its panel', () => {
    inTwoPanels();
    expect(removeButtons()).toEqual(
      expect.arrayContaining([
        'Fjern Fremgangsmåte fra feltet midten',
        'Fjern Fremgangsmåte fra feltet høyre',
      ]),
    );
    expect(removeButtons()).not.toContain('Fjern Fremgangsmåte');
  });

  it('takes a block that stands in two panels out of the panel whose «Fjern» is pressed only', async () => {
    inTwoPanels();
    await remove('Fjern Fremgangsmåte fra feltet høyre');
    expect(switchIn('Høyre', 'Fremgangsmåte').checked).toBe(false);
    expect(switchIn('Midten', 'Fremgangsmåte').checked).toBe(true);
    expect(removeButtons()).toContain('Fjern Fremgangsmåte');
  });
});
