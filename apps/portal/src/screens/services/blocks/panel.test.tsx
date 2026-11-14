// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  blocksIn,
  defaultLayout,
  factsFromDefinition,
  zones,
  type ServiceFacts,
} from '@genai/ui-blocks/builder';
import { afterEach, describe, expect, it } from 'vitest';
import { BlocksPanel } from './BlocksPanel';
import { useBlocksState } from './BlocksStep';
import { draftChannels } from './channels';
import { TemplatesPanel } from './TemplatesPanel';

afterEach(cleanup);

// Every built block on, in its default zone.
const everyBlock = () => ({ layout: defaultLayout });

const Harness = ({ facts }: { facts?: ServiceFacts | undefined }) => {
  const blocks = useBlocksState(everyBlock, facts);
  return (
    <>
      <BlocksPanel state={blocks.state} facts={blocks.facts} onChange={blocks.change} />
      <output aria-label="Tegnes">
        {zones.flatMap((zone) => blocksIn(blocks.layout, zone)).join(' ')}
      </output>
    </>
  );
};

const descriptionOf = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();

/** The blocks the layout draws, whatever the panel shows as chosen. */
const drawn = () => (screen.getByRole('status', { name: 'Tegnes' }).textContent ?? '').split(' ');

const switchIn = (group: string, name: string | RegExp) =>
  within(screen.getByRole('group', { name: group })).getByRole('switch', {
    name,
  }) as HTMLInputElement;

// An invented draft that answers in a chat and searches nothing.
const plainChat = factsFromDefinition(
  {
    metadata: { id: 'svarhjelp', name: 'Svarhjelp' },
    spec: { output: { kind: 'answer' }, exposure: { chat: true } },
  },
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

  it('keeps a chosen block the draft cannot back as chosen, says why it waits, and does not draw it', () => {
    render(<Harness facts={plainChat} />);
    const filter = switchIn('Venstre panel', 'Filter');
    expect(filter.checked).toBe(true);
    expect(filter.disabled).toBe(false);
    expect(descriptionOf(filter)).toBe(
      'Valgt, men vises ikke ennå. Dokumentsamlingen har ingen felt å filtrere på. Den kommer når tjenesten har det den trenger.',
    );
    // Not chosen in the content, where it may also stand: only why it cannot be.
    expect(descriptionOf(switchIn('Innhold', 'Filter'))).toBe(
      'Dokumentsamlingen har ingen felt å filtrere på.',
    );
    expect(switchIn('Høyre panel', 'Kilder').checked).toBe(true);
    expect(drawn()).not.toContain('filter');
    expect(drawn()).not.toContain('sources');
    expect(drawn()).toContain('chat');
  });

  it('lets go of a waiting block turned off, which then stays off and says only why it cannot be on', () => {
    const { rerender } = render(<Harness facts={plainChat} />);
    fireEvent.click(switchIn('Venstre panel', 'Filter'));
    const filter = switchIn('Venstre panel', 'Filter');
    expect(filter.checked).toBe(false);
    expect(filter.disabled).toBe(true);
    expect(descriptionOf(filter)).toBe('Dokumentsamlingen har ingen felt å filtrere på.');
    rerender(<Harness facts={withDataset} />);
    expect(switchIn('Venstre panel', 'Filter').checked).toBe(false);
    expect(drawn()).not.toContain('filter');
    expect(drawn()).toContain('sources');
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

// The same draft once it searches a dataset whose own fields can narrow it.
const withDataset = factsFromDefinition(
  {
    metadata: { id: 'svarhjelp', name: 'Svarhjelp', tenant: 'eksempel' },
    spec: {
      output: { kind: 'answer' },
      exposure: { chat: true },
      knowledge: { datasets: [{ dataset: 'eksempel/veiledere' }] },
    },
  },
  { channels: draftChannels, filtersOf: () => [{ field: 'tema', kinds: ['multiselect'] }] },
);

const WithTemplates = ({
  facts,
  start,
}: {
  facts?: ServiceFacts | undefined;
  start?: typeof everyBlock;
}) => {
  const blocks = useBlocksState(start, facts);
  return (
    <>
      <TemplatesPanel current={blocks.template} onPick={blocks.pick} />
      <BlocksPanel state={blocks.state} facts={blocks.facts} onChange={blocks.change} />
    </>
  );
};

describe('the blocks a draft cannot back yet', () => {
  it('holds them, and puts them back where they stood once the draft can back them', () => {
    const { rerender } = render(<Harness facts={plainChat} />);
    expect(drawn()).not.toContain('filter');
    rerender(<Harness facts={withDataset} />);
    expect(switchIn('Venstre panel', 'Filter').checked).toBe(true);
    expect(switchIn('Høyre panel', 'Kilder').checked).toBe(true);
    expect(drawn()).toEqual(expect.arrayContaining(['filter', 'sources']));
  });
});

describe('the templates', () => {
  it('start from Kunnskapsassistenten, ny utgave, the next look, when no layout is kept', () => {
    render(<WithTemplates />);
    expect(
      screen.getAllByRole('button', { pressed: true }).map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Bruk Kunnskapsassistenten, ny utgave']);
  });

  it('start from the kept layout and no template when one is kept', () => {
    render(<WithTemplates start={everyBlock} />);
    expect(screen.queryAllByRole('button', { pressed: true })).toEqual([]);
    expect(switchIn('Høyre panel', 'Kilder').checked).toBe(true);
  });

  it('take a template’s layout, and hold the blocks the draft cannot back until it can', () => {
    const { rerender } = render(<WithTemplates facts={plainChat} />);
    fireEvent.click(screen.getByRole('button', { name: 'Bruk Bare kilder' }));
    expect(
      screen.getByRole('button', { name: 'Bruk Bare kilder' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getAllByText(/Valgt, men vises ikke ennå/).length).toBeGreaterThan(0);
    expect(switchIn('Innhold', 'Chat').checked).toBe(true);
    rerender(<WithTemplates facts={withDataset} />);
    expect(switchIn('Venstre panel', 'Filter').checked).toBe(true);
    expect(switchIn('Høyre panel', 'Kilder').checked).toBe(true);
    expect(switchIn('Innhold', 'Fremgangsmåte').checked).toBe(false);
  });

  it('mark the blocks not built yet as coming in a template’s list', () => {
    render(<WithTemplates />);
    expect(screen.getByRole('button', { name: 'Bruk Kunnskapsassistenten' }).textContent).toContain(
      'Notater (kommer)',
    );
  });
});

describe('a block that may stand in both its zones', () => {
  it('stands in the content and the right panel when it is turned on in each, and in one when turned off there', () => {
    render(<Harness />);
    expect(switchIn('Innhold', 'Fremgangsmåte').checked).toBe(true);
    expect(switchIn('Høyre panel', 'Fremgangsmåte').checked).toBe(false);
    fireEvent.click(switchIn('Høyre panel', 'Fremgangsmåte'));
    expect(switchIn('Innhold', 'Fremgangsmåte').checked).toBe(true);
    expect(switchIn('Høyre panel', 'Fremgangsmåte').checked).toBe(true);
    fireEvent.click(switchIn('Innhold', 'Fremgangsmåte'));
    expect(switchIn('Innhold', 'Fremgangsmåte').checked).toBe(false);
    expect(switchIn('Høyre panel', 'Fremgangsmåte').checked).toBe(true);
  });

  it('draws one set of options for it, under its first zone', () => {
    render(<Harness />);
    fireEvent.click(switchIn('Høyre panel', 'Fremgangsmåte'));
    expect(screen.getAllByText('Valg for Fremgangsmåte')).toHaveLength(1);
  });
});
