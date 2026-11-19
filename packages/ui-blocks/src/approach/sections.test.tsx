// @vitest-environment jsdom
// The `sections` variant: the dev boards' card, the filter first when given, then «Prosess».
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Approach, type ApproachProps, type ApproachStep } from './Approach.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const started = Date.parse('2026-11-02T10:00:00Z');

const steps: ApproachStep[] = [
  {
    id: 'understand',
    title: 'Forsto spørsmålet',
    description: '«Tatt i bruk» = satt i drift.',
    status: 'done',
  },
  { id: 'r1', title: 'Leste de relevante delene nøye', status: 'done', excerptsRead: 3 },
  { id: 'r2', title: 'Leste de relevante delene nøye', status: 'done', excerptsRead: 2 },
  { id: 'write', title: 'Skrev svaret', status: 'done' },
];

const done = (props: Partial<ApproachProps> = {}) =>
  render(
    <Approach
      steps={steps}
      working={false}
      startedAt={started}
      finishedAt={started + 41_000}
      read={44}
      used={4}
      variant="sections"
      {...props}
    />,
  );

const card = () => document.querySelector('.uib-approach') as HTMLElement;
const process = () => within(card()).getByRole('list', { name: 'Prosess', hidden: true });

describe('the sections card', () => {
  it('is Designsystemet’s Card with Details, titled «Fremgangsmåte» and closed once the answer is done', () => {
    done();
    const details = card().querySelector('.ds-card > details') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toBe('Fremgangsmåte');
    expect(details.open).toBe(false);
  });

  it('starts at «Prosess» with no divider when the service has no filter (dev-fremgangsmate-2)', () => {
    done();
    const content = card().querySelector('.uib-approach-content') as HTMLElement;
    expect(content.firstElementChild?.textContent).toBe('Prosess');
    expect(content.querySelector('.ds-divider')).toBeNull();
  });

  it('puts the filter first and a divider before «Prosess» when given (dev-fremgangsmate-1)', () => {
    done({ filter: <p>Filteret svaret bygger på</p> });
    const content = card().querySelector('.uib-approach-content') as HTMLElement;
    expect([...content.children].map((child) => child.textContent)).toEqual([
      'Filteret svaret bygger på',
      '',
      'Prosess',
      expect.any(String),
      'Tok 41 sekunder',
    ]);
    expect(content.children[1]?.classList).toContain('ds-divider');
  });

  it('numbers the steps, each with its title and one line under it, the excerpts a run read added up', () => {
    done();
    const items = within(process()).getAllByRole('listitem', { hidden: true });
    expect(
      items.map((item) => item.querySelector('.uib-approach-step-title')?.textContent),
    ).toEqual(['Forsto spørsmålet', 'Leste de relevante delene nøye (2 ganger)', 'Skrev svaret']);
    expect(
      items.map((item) => item.querySelector('.uib-approach-step-description')?.textContent),
    ).toEqual(['«Tatt i bruk» = satt i drift.', 'Leste 5 utdrag nøye', undefined]);
  });

  it('says only how long it took at the foot, not the totals', () => {
    done();
    expect(card().querySelector('.uib-approach-footer')?.textContent).toBe('Tok 41 sekunder');
    expect(screen.queryByText(/brukte 4/)).toBeNull();
  });

  it('is open while the assistant works, the step in progress marked, and says how long so far', () => {
    render(
      <Approach
        steps={[steps[0] as ApproachStep, { id: 'w', title: 'Skrev svaret', status: 'active' }]}
        working
        startedAt={started}
        now={() => started + 12_000}
        variant="sections"
      />,
    );
    expect((card().querySelector('details') as HTMLDetailsElement).open).toBe(true);
    const active = within(process()).getByText('Skrev svaret').closest('li');
    expect(active?.getAttribute('aria-current')).toBe('step');
    expect(active?.textContent).toContain('pågår');
    expect(card().querySelector('.uib-approach-footer')?.textContent).toBe(
      'Har jobbet i 12 sekunder',
    );
  });
});
