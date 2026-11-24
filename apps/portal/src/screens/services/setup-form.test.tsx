// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupAreas, type SetupArea } from './setup-diff';
import { SetupForm } from './setup-form';
import type { AreaFact } from './setup-layout';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const facts = Object.fromEntries(
  setupAreas.map((a): [SetupArea, AreaFact] => [a, { status: 'done', summary: '' }]),
) as Record<SetupArea, AreaFact>;

const form = (withChat = true) =>
  render(
    <SetupForm
      facts={facts}
      area={(a) => <p>Felt for {a}</p>}
      {...(withChat ? { assistant: <p>Byggeassistent</p> } : {})}
    />,
  );

describe('the new Oppsett as one form', () => {
  it('shows the basic areas and Modell in one form, and the rest elsewhere', () => {
    form();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Formål og målgruppe', 'Kunnskap', 'Inndata', 'Resultat', 'Modell']);
    expect(screen.queryByText('Felt for tools')).toBeNull();
    expect(screen.queryByText('Felt for risk')).toBeNull();
  });

  it('makes the chat wider and narrower with the arrow keys, between 320 and 640 px', () => {
    form();
    const line = screen.getByRole('separator', { name: 'Endre bredden på chatten' });
    expect(line.getAttribute('aria-valuenow')).toBe('400');
    fireEvent.keyDown(line, { key: 'ArrowRight' });
    expect(line.getAttribute('aria-valuenow')).toBe('416');
    fireEvent.keyDown(line, { key: 'End' });
    fireEvent.keyDown(line, { key: 'ArrowRight' });
    expect(line.getAttribute('aria-valuenow')).toBe('640');
    fireEvent.keyDown(line, { key: 'Home' });
    fireEvent.keyDown(line, { key: 'ArrowLeft' });
    expect(line.getAttribute('aria-valuenow')).toBe('320');
  });

  it('keeps the chat width for the next visit in this browser', () => {
    form();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    cleanup();
    form();
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('416');
  });

  it('has no line to drag when there is no assistant, as for someone who can only read', () => {
    form(false);
    expect(screen.queryByRole('separator')).toBeNull();
  });
});
