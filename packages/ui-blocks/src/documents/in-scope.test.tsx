// @vitest-environment jsdom
// «Dokumentene som blir med» (dev-filter-panel; «9 · Filtrering», choice 7): the count always, the
// documents only where the host has them.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentsInScope, type DocumentInScope } from './Documents.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const kudos = { key: 'kudos', label: 'Kudos' };
const documents: DocumentInScope[] = [
  {
    id: '1',
    title: 'Evaluering av KI-piloter i staten',
    type: 'Evaluering',
    organisation: 'Digitaliseringsdirektoratet',
    year: 2024,
    pages: 52,
    included: true,
  },
  {
    id: '2',
    title: 'Tilsyn med automatiserte vedtak',
    type: 'Tilsynsrapport',
    organisation: 'Datatilsynet',
    year: 2023,
    pages: 41,
    included: false,
  },
];
const summary = () => document.querySelector('.uib-documents-scope-summary')?.textContent;

describe('DocumentsInScope', () => {
  it('says how many of the collection’s documents the next question reads from', () => {
    render(<DocumentsInScope count={8781} total={45778} corpus={kudos} />);
    expect(screen.getByRole('region', { name: 'Dokumentene som blir med' })).toBeTruthy();
    expect(summary()).toBe('Assistenten leser fra 8 781 av 45 778 dokumenter i Kudos');
  });

  it('draws no list, no search and no ticks without the host’s documents', () => {
    render(<DocumentsInScope count={8781} total={45778} corpus={kudos} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/Fjern haken/)).toBeNull();
  });

  it('is not drawn with neither a count nor documents', () => {
    const { container } = render(<DocumentsInScope corpus={kudos} />);
    expect(container.textContent).toBe('');
  });

  it('folds with «Skjul», and opens again with «Vis»', () => {
    render(<DocumentsInScope count={8781} total={45778} corpus={kudos} />);
    const toggle = screen.getByRole('button', { name: /Dokumentene som blir med/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('Skjul');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Vis');
  });

  it('lists the host’s documents with their type, organisation, year and pages, each a tick', () => {
    const changed: [string, boolean][] = [];
    render(
      <DocumentsInScope
        count={8781}
        corpus={kudos}
        documents={documents}
        onIncludedChange={(id, included) => changed.push([id, included])}
      />,
    );
    const first = screen.getByRole('checkbox', { name: /Evaluering av KI-piloter/ });
    expect(first.closest('.uib-documents-scope-document')?.textContent).toBe(
      'Evaluering av KI-piloter i statenEvalueringDigitaliseringsdirektoratet · 2024 · 52 sider',
    );
    fireEvent.click(first);
    expect(changed).toEqual([['1', false]]);
  });

  it('narrows the list by title or organisation as the reader types', () => {
    render(
      <DocumentsInScope
        count={2}
        corpus={kudos}
        documents={documents}
        onIncludedChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i dokumentene som blir med' }), {
      target: { value: 'datatilsynet' },
    });
    const list = screen.getByRole('list', { name: 'Dokumentene som blir med' });
    expect(
      within(list)
        .getAllByRole('checkbox')
        .map((box) => box.getAttribute('value') ?? ''),
    ).toHaveLength(1);
    expect(within(list).getByText('Tilsyn med automatiserte vedtak')).toBeTruthy();
  });

  it('keeps the ticks still without a handler, so no tick seems to work that does not', () => {
    render(<DocumentsInScope count={2} corpus={kudos} documents={documents} />);
    expect(screen.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).disabled)).toBe(
      true,
    );
  });
});
