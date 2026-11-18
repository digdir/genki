// @vitest-environment jsdom
// The dev boards' Fremgangsmåte in the answer (dev-filter-panel; «9 · Filtrering» B, choice 5): a
// one-line bar when folded, with the totals and «filteret er endret», and what the answer read
// from at the top when open. Brought from the designer's design.test.tsx (local/kn-approach) where
// the board agrees with it; its scope stood outside the fold, which this board puts inside.
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Approach, type ApproachProps, type ApproachStep } from './Approach.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const started = Date.parse('2026-11-02T13:01:19Z');
const finished = started + 41_000;
const steps: ApproachStep[] = [
  { id: 'a', title: 'Forsto spørsmålet', status: 'done' },
  { id: 'b', title: 'Skrev svaret', status: 'done' },
];

const done = (props: Partial<ApproachProps> = {}) =>
  render(
    <Approach steps={steps} working={false} startedAt={started} finishedAt={finished} {...props} />,
  );
const footer = () => document.querySelector('.uib-approach-footer')?.textContent;
const subtitle = () => document.querySelector('.uib-approach-subtitle')?.textContent;
const summary = () => document.querySelector('summary') as HTMLElement;

describe('without the new props', () => {
  it('draws the card as it was: the totals in the foot, nothing beside the title', () => {
    done({ read: 214, used: 4 });
    expect(subtitle()).toBeUndefined();
    expect(footer()).toBe('Leste 214 dokumenter, brukte 4 · tok 41 sekunder');
    expect(document.querySelector('.uib-approach')?.hasAttribute('data-summary')).toBe(false);
  });
});

describe('the totals in the head (summary="totals")', () => {
  it('says how much was read and used beside the title, and leaves the time to the foot', () => {
    done({ read: 44, used: 4, summary: 'totals' });
    expect(subtitle()).toBe('Leste 44 dokumenter, brukte 4');
    expect(footer()).toBe('Tok 41 sekunder');
  });

  it('stands in the summary, so it shows while the card is folded', () => {
    done({ read: 44, used: 4, summary: 'totals' });
    expect(within(summary()).getByText('Leste 44 dokumenter, brukte 4')).toBeTruthy();
    expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(false);
  });

  it('says what genki sends: the sources used, when it says nothing of what was read', () => {
    done({ used: 4, summary: 'totals' });
    expect(subtitle()).toBe('Brukte 4 kilder');
  });

  it('says nothing beside the title while the assistant works', () => {
    render(<Approach steps={steps} working startedAt={started} summary="totals" note="x" />);
    expect(subtitle()).toBeUndefined();
  });

  it('ends the line with the note, stronger, when the host gives one', () => {
    done({ read: 44, used: 4, summary: 'totals', note: 'filteret er endret' });
    expect(subtitle()).toBe('Leste 44 dokumenter, brukte 4 · filteret er endret');
    expect(document.querySelector('.uib-approach-note')?.textContent).toBe(' · filteret er endret');
  });

  it('keeps the card named Fremgangsmåte for a screen reader', () => {
    done({ used: 4, summary: 'totals', note: 'filteret er endret' });
    expect(screen.getByRole('group', { name: 'Fremgangsmåte' })).toBeTruthy();
  });

  it('puts the chevron at the end of the bar, not before the title', () => {
    const css = readFileSync(`${import.meta.dirname}/approach.css`, 'utf8').replace(/\s+/g, ' ');
    expect(css).toContain(
      ".uib-approach[data-summary='totals'] summary::before { order: 1; align-self: center; margin-inline-start: auto;",
    );
  });
});

describe('the scope inside the card', () => {
  const scope = (
    <ul aria-label="Filteret dette svaret bygger på">
      <li>Evaluering</li>
      <li>Tilsynsrapport</li>
    </ul>
  );

  it('stands at the top of the open card, before the steps, and folds with them', () => {
    done({ scope, summary: 'totals' });
    const details = document.querySelector('details') as HTMLDetailsElement;
    const content = details.querySelector('.uib-approach-content') as HTMLElement;
    expect(content.firstElementChild?.className).toBe('uib-approach-scope');
    expect(within(content).getByText('Tilsynsrapport')).toBeTruthy();
    expect(details.open).toBe(false);
    fireEvent.click(summary());
    expect(details.open).toBe(true);
  });
});
