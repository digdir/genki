// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { factsFromDefinition, type ServiceFacts } from '@genai/ui-blocks/builder';
import { afterEach, describe, expect, it } from 'vitest';
import { BlocksPanel } from './BlocksPanel';
import { useBlocksState } from './BlocksStep';
import { draftChannels } from './channels';

afterEach(cleanup);

const Harness = ({ facts }: { facts?: ServiceFacts | undefined }) => {
  const blocks = useBlocksState(undefined, facts);
  return <BlocksPanel state={blocks.state} facts={blocks.facts} onChange={blocks.change} />;
};

const switchIn = (group: string, name: string | RegExp) =>
  within(screen.getByRole('group', { name: group })).getByRole('switch', {
    name,
  }) as HTMLInputElement;

// An invented draft that answers in a chat and searches nothing.
const plainChat = factsFromDefinition(
  { metadata: { id: 'svarhjelp', name: 'Svarhjelp' }, spec: { output: { kind: 'answer' } } },
  { channels: draftChannels },
);

describe('the building blocks per panel', () => {
  it('moves Chat to the right panel when it is turned on there', () => {
    render(<Harness />);
    expect(switchIn('Innhold', 'Chat').checked).toBe(true);
    expect(switchIn('Høyre panel', 'Chat').disabled).toBe(false);
    fireEvent.click(switchIn('Høyre panel', 'Chat'));
    expect(switchIn('Høyre panel', 'Chat').checked).toBe(true);
    expect(switchIn('Innhold', 'Chat').checked).toBe(false);
  });

  it('marks Prosjekter and Notater as coming, from the catalogue, and keeps them off', () => {
    render(<Harness />);
    for (const [group, name] of [
      ['Venstre panel', 'Prosjekter (kommer)'],
      ['Høyre panel', 'Notater (kommer)'],
    ] as const) {
      expect(switchIn(group, name).disabled).toBe(true);
      expect(switchIn(group, name).checked).toBe(false);
    }
    expect(switchIn('Venstre panel', 'Tråder').disabled).toBe(false);
  });

  it('turns off and disables a block the draft cannot back, and says why', () => {
    render(<Harness facts={plainChat} />);
    const filter = switchIn('Venstre panel', 'Filter');
    expect(filter.checked).toBe(false);
    expect(filter.disabled).toBe(true);
    expect(screen.getAllByText('Dokumentsamlingen har ingen felt å filtrere på.').length).toBe(2);
    expect(switchIn('Høyre panel', 'Kilder').disabled).toBe(true);
    expect(switchIn('Innhold', 'Chat').checked).toBe(true);
  });
});

describe('the options on a block', () => {
  it('draws the options of a block that is on under «Valg for …», and keeps what is changed', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Valg for Chat'));
    const suggestions = screen.getByRole('switch', { name: /Forslag til spørsmål/ });
    expect((suggestions as HTMLInputElement).checked).toBe(true);
    fireEvent.click(suggestions);
    expect(
      (screen.getByRole('switch', { name: /Forslag til spørsmål/ }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('lists an option the draft cannot back, or that is not built, with why and no switch', () => {
    render(<Harness facts={plainChat} />);
    fireEvent.click(screen.getByText('Valg for Chat'));
    expect(
      screen.getByText('Tilbakemelding: Tilbakemelding er ikke slått på for denne brukerflaten.'),
    ).toBeTruthy();
    expect(screen.getByText('Vedlegg (kommer)')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: /Tilbakemelding/ })).toBeNull();
  });
});
