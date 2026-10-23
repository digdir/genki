// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
    expect(item.textContent).toContain('Publisert 1. mars 2026');
    const toggle = screen.getByRole('button', { name: 'Utdrag fra Kudos-rapport' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const excerpt = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(excerpt?.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(excerpt?.hidden).toBe(false);
    expect(excerpt?.textContent).toBe('Permisjon gis etter søknad. '.repeat(30).trim());
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

  it('lists a document once with all its excerpts, however many chunks were cited', () => {
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
    expect(items[0]?.getAttribute('value')).toBe('1');
    expect(items[1]?.getAttribute('value')).toBe('3');
    expect(items[0]?.textContent).not.toMatch(/\[\d+\]/);
  });
});

describe('source excerpts in Prøveområde', () => {
  it('renders Markdown headings, bold, lists and safe links without flattening or truncating it', () => {
    const text = `# Veiledning\n\n**Permisjon**\n\n- Vilkår: søknad\n- Frist: juni\n\n${'Mer informasjon. '.repeat(30)}\n\nLes [veilederen](https://example.no/guide)`;
    card(result({ sources: [{ chunkId: 'c1', title: 'Veileder', text }] }));

    fireEvent.click(screen.getByRole('button', { name: 'Utdrag fra Veileder' }));
    const excerpt = screen.getByRole('region', { name: 'Utdrag fra Veileder' });
    expect(within(excerpt).getByText('Veiledning').closest('.answer-heading')).toBeTruthy();
    expect(within(excerpt).getByText('Permisjon').tagName).toBe('STRONG');
    expect(
      within(excerpt)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Vilkår: søknad', 'Frist: juni']);
    const link = within(excerpt).getByRole('link', { name: 'veilederen' });
    expect(link.getAttribute('href')).toBe('https://example.no/guide');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')?.split(' ')).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer']),
    );
    expect(excerpt.textContent).not.toContain('**');
    expect(excerpt.textContent).toContain('Mer informasjon. '.repeat(30).trim());
    expect(excerpt.tabIndex).toBe(0);
  });

  it.each(['excerpt', 'details'] as const)(
    'neutralises scripts, raw HTML and unsafe Markdown links in the %s view',
    (view) => {
      const text =
        '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<svg onload=alert(1)></svg>\n\n<a href="javascript:alert(1)">raw link</a>\n\n[x](javascript:alert(1)) [data](data:text/html,bad)';
      const { container } = card(result({ sources: [{ chunkId: 'c1', title: 'Veileder', text }] }));
      fireEvent.click(
        screen.getByRole('button', {
          name: view === 'excerpt' ? 'Utdrag fra Veileder' : 'Detaljer om Veileder',
        }),
      );
      const excerpt = screen.getByRole('region', { name: 'Utdrag fra Veileder' });
      expect(excerpt.querySelector('script, img, svg, a, [onerror], [onload]')).toBeNull();
      expect(excerpt.textContent).toContain('<script>alert(1)</script>');
      expect(excerpt.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(container.querySelector('a[href^="javascript:"], a[href^="data:"]')).toBeNull();
    },
  );

  it('keeps the dataset and a single ordinal in the list, with technical identifiers behind info', () => {
    const { container } = card(
      result({
        sources: [
          {
            chunkId: 'digdir/ai-policy::chunk-123',
            document: 'digdir/ai-policy::doc-456',
            title: 'Veileder',
            headers: ['Kapittel 1'],
            version: 2,
            text: 'Utdrag.',
          },
        ],
        citations: [{ index: 1, chunkId: 'digdir/ai-policy::chunk-123' }],
      }),
    );
    const sources = screen.getByRole('list', { name: 'Kilder' });
    const row = container.querySelector('.playground-source-row') as HTMLElement;
    expect(within(sources).getAllByRole('listitem')).toHaveLength(1);
    expect(sources.querySelector('li')?.value).toBe(1);
    expect(row.textContent).toContain('digdir/ai-policy');
    expect(sources.textContent).not.toContain('[1]');
    expect(row.textContent).not.toMatch(/chunk-123|doc-456|Kapittel 1|Publisert/);
    expect(screen.queryByText('digdir/ai-policy::chunk-123')).toBeNull();
    const info = within(row).getByRole('button', { name: 'Detaljer om Veileder' });
    expect(info.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(info);
    expect(info.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('digdir/ai-policy::chunk-123')).toBeTruthy();
    expect(screen.getByText('digdir/ai-policy::doc-456')).toBeTruthy();
    expect(screen.getByText('Versjon')).toBeTruthy();
    fireEvent.click(info);
    expect(screen.queryByText('digdir/ai-policy::chunk-123')).toBeNull();
  });

  it('names each disclosure after its source, connects it to its content, and closes on a second click', () => {
    card(
      result({
        sources: [
          { chunkId: 'c1', title: 'Første', excerpt: '**Utdrag**' },
          { chunkId: 'c2', title: 'Andre', excerpt: '- Liste' },
        ],
      }),
    );
    const first = screen.getByRole('button', { name: 'Utdrag fra Første' });
    const second = screen.getByRole('button', { name: 'Utdrag fra Andre' });
    expect(first.tagName).toBe('BUTTON');
    expect(first.getAttribute('aria-controls')).not.toBe(second.getAttribute('aria-controls'));
    fireEvent.click(first);
    expect(screen.getByRole('region', { name: 'Utdrag fra Første' }).id).toBe(
      first.getAttribute('aria-controls'),
    );
    expect(second.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Utdrag fra Første' })).toBeNull();
  });

  it('translates source controls, publication labels and missing titles into English', () => {
    render(
      inEnglish(
        <AnswerCard
          result={result({
            text: 'Answer [1].',
            sources: [{ chunkId: 'secret-id', text: 'Excerpt', publishedAt: '2026-03-01' }],
            citations: [{ index: 1, chunkId: 'secret-id' }],
          })}
          saveExpanded={false}
          onSave={() => {}}
          onShowCall={() => {}}
        />,
      ),
    );
    expect(screen.getByText('Untitled source')).toBeTruthy();
    expect(screen.getByText('Published 1 March 2026')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Excerpt from Untitled source' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Details about Untitled source' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Source 1: Untitled source' })).toBeTruthy();
    expect(screen.queryByText('secret-id')).toBeNull();
  });

  it.each(['', '   '])('uses the translated fallback for a blank title (%j)', (title) => {
    card(
      result({
        sources: [{ chunkId: 'secret-id', title, url: 'https://example.no', text: 'Utdrag.' }],
      }),
    );

    expect(screen.getByRole('link', { name: 'Kilde uten tittel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Utdrag fra Kilde uten tittel' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Detaljer om Kilde uten tittel' }));
    expect(screen.getByRole('heading', { name: /Kilde uten tittel/ })).toBeTruthy();
  });
});
