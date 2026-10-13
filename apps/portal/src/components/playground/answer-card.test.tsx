// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlaygroundResult } from '../../api/playground';
import { AnswerCard, groupSources } from './AnswerCard';

afterEach(cleanup);

const result = (over: Partial<PlaygroundResult>): PlaygroundResult => ({
  runId: 'run-1',
  sources: [{ chunkId: 'c1', title: 'Veileder om permisjon', url: 'https://example.no/v' }],
  searchNotes: [],
  timeMs: 900,
  tokensIn: 10,
  tokensOut: 0,
  costNok: 0,
  dataLocation: 'eu',
  ...over,
});

const card = (r: PlaygroundResult) =>
  render(<AnswerCard result={r} saveExpanded={false} onSave={() => {}} onShowCall={() => {}} />);

describe('an answer in Prøveområde', () => {
  it.each([
    ['marked by the API', { text: '', noAnswer: true }],
    ['with empty text', { text: '' }],
  ])('says no answer was found, with the sources, when it is %s', (_label, over) => {
    card(result(over));

    expect(screen.getByText('Fant ikke noe svar i kildene')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Veileder om permisjon' })).toBeTruthy();
  });

  it('shows the text when there is an answer', () => {
    card(result({ text: 'Du har rett til permisjon.' }));

    expect(screen.getByText('Du har rett til permisjon.')).toBeTruthy();
    expect(screen.queryByText('Fant ikke noe svar i kildene')).toBeNull();
  });

  it('says Ikke priset when the model has no price, not 0,00 kr', () => {
    card(result({ text: 'Svar.', costNok: null }));

    expect(screen.getByText('Ikke priset')).toBeTruthy();
    expect(screen.queryByText('0,00 kr')).toBeNull();
  });

  it('labels a real answer as made with AI and shows sources as links with an excerpt', () => {
    card(
      result({
        text: 'Du har rett til permisjon.',
        sources: [
          {
            chunkId: 'c1',
            title: 'Kudos-rapport',
            url: 'digdir://doc/48211',
            text: 'Permisjon gis etter søknad. '.repeat(30),
            version: 2,
            publishedAt: '2026-03-01',
          },
          { chunkId: 'c2', title: 'Notat', url: 'chunk:c2' },
        ],
      }),
    );

    expect(screen.getByText('Svar laget med KI')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Kudos-rapport' }).getAttribute('href')).toBe(
      'https://kudos.dfo.no/dokumenter?query=Kudos-rapport',
    );
    const item = screen.getByRole('link', { name: 'Kudos-rapport' }).closest('li') as HTMLElement;
    expect(item.textContent).toContain('versjon 2, 1. mars 2026');
    const details = item.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect((details.textContent ?? '').length).toBeLessThan(320);
    expect(screen.queryByRole('link', { name: 'Notat' })).toBeNull();
  });

  it('does not label an empty answer as made with AI', () => {
    card(result({ text: '' }));
    expect(screen.queryByText('Svar laget med KI')).toBeNull();
  });
});

describe('a table answer in Prøveområde', () => {
  it('shows a table with numbered source links per cell, the source list and a CSV download', () => {
    card(
      result({
        sources: [],
        csv: 'Mål,Mål (kilde)\r\nFelles løsninger,Årsrapport',
        table: {
          kind: 'table',
          title: 'Måloppnåelse',
          columns: [{ key: 'goal', label: 'Mål' }],
          rows: [
            {
              cells: {
                goal: {
                  value: 'Felles løsninger',
                  sources: [
                    { chunkId: 'c1', title: 'Årsrapport Digdir 2024', url: 'digdir://doc/48211' },
                    { chunkId: 'c2', title: 'Uten lenke' },
                  ],
                },
              },
            },
          ],
          skipped: [],
        },
      }),
    );

    const table = screen.getByRole('table', { name: 'Måloppnåelse' });
    expect(table.textContent).toContain('Felles løsninger');
    expect(
      screen.getByRole('link', { name: 'Kilde 1: Årsrapport Digdir 2024' }).getAttribute('href'),
    ).toBe('https://kudos.dfo.no/dokumenter?query=%C3%85rsrapport%20Digdir%202024');
    expect(screen.getByLabelText('Kilde 2: Uten lenke')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Årsrapport Digdir 2024' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Last ned CSV' }).getAttribute('href')).toMatch(
      /^data:text\/csv;charset=utf-8,/,
    );
    expect(screen.getByText('Svar laget med KI')).toBeTruthy();
  });
});

describe('answer text in Prøveområde', () => {
  it('renders bold, italic, lists and links as markup, never as literal markdown or HTML', () => {
    const { container } = card(
      result({
        text: 'Digdirs **viktigste mål** er:\n\n- samordning\n- *felles* løsninger\n\nLes [mer](https://www.digdir.no) <img src=x onerror=alert(1)> [x](javascript:alert(1))',
      }),
    );
    const text = container.querySelector('.playground-markdown') as HTMLElement;

    expect(text.textContent).not.toContain('**');
    expect(screen.getByText('viktigste mål').tagName).toBe('STRONG');
    expect(screen.getByText('felles').tagName).toBe('EM');
    expect(text.querySelectorAll('ul > li')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'mer' }).getAttribute('target')).toBe('_blank');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });

  it('lists a document once with all its [N] and excerpts, however many chunks were cited', () => {
    const r = result({
      text: 'Først [1] og så [2], samt [3].',
      sources: [
        { chunkId: 'c1', title: 'Tildelingsbrev 2024', document: '48211', text: 'Første utdrag.' },
        { chunkId: 'c2', title: 'Tildelingsbrev 2024', document: '48211', text: 'Andre utdrag.' },
        { chunkId: 'c3', title: 'Årsrapport 2024', document: '48300', text: 'Tredje.' },
      ],
      citations: [
        { index: 1, chunkId: 'c1' },
        { index: 2, chunkId: 'c2' },
        { index: 3, chunkId: 'c3' },
      ],
    });
    expect(groupSources(r).map((g) => [g.first.title, g.numbers])).toEqual([
      ['Tildelingsbrev 2024', [1, 2]],
      ['Årsrapport 2024', [3]],
    ]);

    const { container } = card(r);
    const items = container.querySelectorAll('.playground-sources > ol > li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Første utdrag.');
    expect(items[0]?.textContent).toContain('Andre utdrag.');
    expect(screen.getAllByText('Tildelingsbrev 2024')).toHaveLength(1);
  });
});
