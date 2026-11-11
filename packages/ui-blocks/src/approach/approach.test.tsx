// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uiBlocksEn, uiBlocksNb } from '../index.js';
import { Approach, type ApproachProps, type ApproachStep } from './Approach.js';
import { en, nb } from './i18n.js';
import { linesOf } from './runs.js';

document.getAnimations ??= () => [];
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const started = Date.parse('2026-11-02T10:00:00Z');

const steps: ApproachStep[] = [
  { id: 'understand', title: 'Forsto spørsmålet', status: 'done' },
  {
    id: 'read',
    title: 'Leste de relevante delene nøye',
    description: 'Det som handler om tilskudd.',
    status: 'active',
    documents: [{ title: 'Årsrapport 2025', detail: 'side 4 til 6' }],
    documentsRead: 17,
  },
  { id: 'write', title: 'Skrev svaret', description: 'Skal ikke vises ennå.', status: 'waiting' },
];

const draw = (props: Partial<ApproachProps> = {}) =>
  render(<Approach steps={steps} working startedAt={started} {...props} />);

const card = () => screen.getByText('Fremgangsmåte').closest('details') as HTMLDetailsElement;
const step = (title: string) => screen.getByText(title).closest('li') as HTMLElement;

describe('the approach card', () => {
  it('is open while the assistant works, with the step in progress marked as the current step', () => {
    draw();
    expect(card().open).toBe(true);
    expect(step('Leste de relevante delene nøye').getAttribute('aria-current')).toBe('step');
    expect(within(step('Leste de relevante delene nøye')).getByText(/pågår/)).toBeTruthy();
    expect(step('Forsto spørsmålet').getAttribute('aria-current')).toBeNull();
    expect(within(step('Forsto spørsmålet')).getByText(/ferdig/).className).toBe(
      'uib-visually-hidden',
    );
  });

  it('shows only the title of a step that waits, with its status as text', () => {
    draw();
    const waiting = step('Skrev svaret');
    expect(within(waiting).getByText(/venter/)).toBeTruthy();
    expect(screen.queryByText('Skal ikke vises ennå.')).toBeNull();
  });

  it('lists what a step read, and offers the rest only when the app can show it', () => {
    const { rerender } = draw();
    expect(screen.getByText('Årsrapport 2025, side 4 til 6')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /som er lest/ })).toBeNull();

    const shown: string[] = [];
    rerender(
      <Approach steps={steps} working startedAt={started} onShowRead={(id) => shown.push(id)} />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Vis de 17 som er lest' }));
    expect(shown).toEqual(['read']);
  });

  it('closes when the answer is done, and says what it read and used and how long it took', () => {
    const { rerender } = draw();
    rerender(
      <Approach
        steps={steps.map((s) => ({ ...s, status: 'done' }))}
        working={false}
        startedAt={started}
        finishedAt={started + 41_000}
        read={214}
        used={4}
      />,
    );
    expect(card().open).toBe(false);
    expect(screen.getByText('Leste 214 dokumenter, brukte 4 · tok 41 sekunder')).toBeTruthy();
  });

  it('stays closed when the person closed it while the assistant worked', () => {
    const { rerender } = draw();
    const summary = screen.getByText('Fremgangsmåte');
    fireEvent.click(summary);
    expect(card().open).toBe(false);
    rerender(<Approach steps={steps} working startedAt={started} />);
    expect(card().open).toBe(false);
    rerender(
      <Approach steps={steps} working={false} startedAt={started} finishedAt={started + 1000} />,
    );
    expect(card().open).toBe(false);
  });

  it('can be opened again when the answer is done', () => {
    draw({ working: false, finishedAt: started + 3000 });
    expect(card().open).toBe(false);
    fireEvent.click(screen.getByText('Fremgangsmåte'));
    expect(card().open).toBe(true);
    expect(screen.getByText('Tok 3 sekunder')).toBeTruthy();
  });

  it('announces the step in progress, not the whole list', () => {
    draw();
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toBe('Steg 2 av 3: Leste de relevante delene nøye');
    expect(live.closest('details')).toBeNull();
  });

  it('counts the seconds while the assistant works', () => {
    vi.useFakeTimers({ now: started + 18_000 });
    draw();
    expect(screen.getByText('Har jobbet i 18 sekunder')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('Har jobbet i 20 sekunder')).toBeTruthy();
  });

  it('counts the seconds by the host’s clock when the host passes one', () => {
    vi.useFakeTimers({ now: started });
    let clock = started + 18_000;
    draw({ now: () => clock });
    expect(screen.getByText('Har jobbet i 18 sekunder')).toBeTruthy();
    clock += 5000;
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText('Har jobbet i 23 sekunder')).toBeTruthy();
  });

  it('links to more about what the assistant did not find, when the app can show it', () => {
    const missing: ApproachStep = {
      id: 'gaps',
      title: 'Det jeg ikke fant',
      description: 'Ingen dokumenter sier hvor mange.',
      status: 'done',
      missing: true,
    };
    const { rerender } = draw({ steps: [missing], working: false, finishedAt: started });
    expect(screen.queryByRole('link', { name: 'Utdyp hva som mangler' })).toBeNull();
    const asked: string[] = [];
    rerender(
      <Approach
        steps={[missing]}
        working={false}
        startedAt={started}
        finishedAt={started}
        onExplainMissing={(id) => asked.push(id)}
      />,
    );
    fireEvent.click(screen.getByText('Fremgangsmåte'));
    fireEvent.click(screen.getByRole('link', { name: 'Utdyp hva som mangler' }));
    expect(asked).toEqual(['gaps']);
  });

  it('says which sources the answer used', () => {
    draw({
      steps: [
        {
          id: 'select',
          title: 'Valgte ut det som svarer på spørsmålet',
          status: 'done',
          sourcesUsed: [1, 2, 3, 4],
        },
      ],
      working: false,
      finishedAt: started,
    });
    expect(screen.getByText('Brukt i svaret: kilde 1, 2, 3 og 4.')).toBeTruthy();
  });

  it('speaks English when the person does', () => {
    render(
      <InLocale locale="en">
        <Approach steps={steps} working startedAt={started} />
      </InLocale>,
    );
    expect(screen.getByText('Approach')).toBeTruthy();
    expect(within(step('Skrev svaret')).getByText(/waiting/)).toBeTruthy();
  });

  it('names its own classes uib-approach, beside the package’s shared hidden text', () => {
    draw({ onShowRead: () => undefined });
    const classes = [...document.querySelectorAll('[class]')].flatMap((el) => [...el.classList]);
    const ours = classes.filter((name) => name.startsWith('uib-'));
    expect(ours.length).toBeGreaterThan(5);
    const shared = new Set(ours.filter((name) => !/^uib-approach(?:-|$)/.test(name)));
    expect([...shared]).toEqual(['uib-visually-hidden']);
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('keeps its words in a catalogue of its own, with no other block’s', () => {
    expect(Object.keys(nb)).toEqual(['approach']);
  });

  it('lends its words to a host through the package’s catalogue of every block', () => {
    expect(uiBlocksNb.approach).toEqual(nb.approach);
    expect(uiBlocksEn.approach).toEqual(en.approach);
  });
});

describe('a run of the same step', () => {
  const run = (titles: string[], extra: Partial<ApproachStep>[] = []): ApproachStep[] =>
    titles.map((title, i) => ({ id: `s${i}`, title, status: 'done', ...extra[i] }));
  const lines = () =>
    [...document.querySelectorAll('.uib-approach-steps > li')].map(
      (li) => li.querySelector('.uib-approach-step-title')?.textContent,
    );

  it('is drawn as one line with a count, when the steps follow one another', () => {
    draw({ steps: run(['Søkte', 'Søkte', 'Søkte', 'Skrev svaret']), working: false });
    expect(lines()).toEqual(['Søkte (3 ganger)', 'Skrev svaret']);
  });

  it('keeps the same step after another one as a line of its own', () => {
    draw({ steps: run(['Søkte', 'Leste', 'Søkte']), working: false });
    expect(lines()).toEqual(['Søkte', 'Leste', 'Søkte']);
  });

  it('is named by the excerpts it read, added up, when its steps say how many', () => {
    const steps = run(
      ['Leste de relevante delene nøye', 'Leste de relevante delene nøye', 'Skrev svaret'],
      [{ excerptsRead: 3 }, { excerptsRead: 9 }],
    );
    draw({ steps, working: false });
    expect(lines()).toEqual(['Leste 12 utdrag nøye', 'Skrev svaret']);
  });

  const runInProgress: ApproachStep[] = [
    { id: 'a', title: 'Søkte', status: 'done' },
    { id: 'b', title: 'Søkte', status: 'active' },
    { id: 'c', title: 'Skrev svaret', status: 'waiting' },
  ];

  it('is in progress while its last step is', () => {
    draw({ steps: runInProgress });
    expect(step('Søkte (2 ganger)').getAttribute('aria-current')).toBe('step');
  });

  it('counts as one line in what is announced', () => {
    draw({ steps: runInProgress });
    const live = document.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toBe('Steg 1 av 2: Søkte (2 ganger)');
  });

  it('leaves out a step that waits, which has not run yet', () => {
    draw({
      steps: [
        { id: 'a', title: 'Søkte', status: 'active', description: 'Nå' },
        { id: 'b', title: 'Søkte', status: 'waiting' },
      ],
    });
    expect(lines()).toEqual(['Søkte', 'Søkte']);
    expect(screen.getByText('Nå')).toBeTruthy();
  });

  it('keeps the first step’s key and shows the newest step’s account', () => {
    const steps: ApproachStep[] = [
      { id: 'a', title: 'Søkte', status: 'done', description: 'Først' },
      { id: 'b', title: 'Søkte', status: 'active', description: 'Så' },
    ];
    expect(linesOf(steps).map((line) => [line.key, line.step.id, line.count])).toEqual([
      ['a', 'b', 2],
    ]);
    draw({ steps });
    expect(screen.getByText('Så')).toBeTruthy();
    expect(screen.queryByText('Først')).toBeNull();
  });
});

describe('a host that keeps the card open or shut', () => {
  it('keeps it open when the answer is done, which the card alone would shut', () => {
    const { rerender } = draw({ open: true });
    rerender(
      <Approach steps={steps} working={false} startedAt={started} finishedAt={started} open />,
    );
    expect(card().open).toBe(true);
  });

  it('keeps it shut while the assistant works, and hears when the person opens it', async () => {
    const asked: boolean[] = [];
    draw({ open: false, onOpenChange: (open) => asked.push(open) });
    expect(card().open).toBe(false);
    fireEvent.click(screen.getByText('Fremgangsmåte'));
    await waitFor(() => expect(asked).toEqual([true]));
    expect(card().open).toBe(false);
  });

  it('opens when the host says so', () => {
    const { rerender } = draw({ working: false, finishedAt: started, open: false });
    expect(card().open).toBe(false);
    rerender(
      <Approach steps={steps} working={false} startedAt={started} finishedAt={started} open />,
    );
    expect(card().open).toBe(true);
  });

  it('tells a host that does not keep it when the person shuts it', async () => {
    const asked: boolean[] = [];
    draw({ onOpenChange: (open) => asked.push(open) });
    fireEvent.click(screen.getByText('Fremgangsmåte'));
    await waitFor(() => expect(asked).toEqual([false]));
    expect(card().open).toBe(false);
  });
});
