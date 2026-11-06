// @vitest-environment jsdom
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en, nb } from '../i18n.js';
import { pairCitations, type SourceCitation } from './pairing.js';
import { Sources, type SourcesProps } from './Sources.js';
import type { SourceDocument } from './types.js';

document.getAnimations ??= () => [];
afterEach(cleanup);

const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

const nkom: SourceDocument = {
  index: 1,
  title: 'Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
  url: 'https://kudos.dfo.no/dokument/2021',
  documentId: 'kudos::2021',
  publishedAt: '2022-03-01',
  excerpts: [
    {
      chunkId: 'kudos::2021-1',
      text: 'Nkoms totale utgiftsbevilgning for 2021 var på **594,2 mill. kroner**.',
      heading: 'Del III › Ressursbruk og måloppnåelse',
      page: 12,
      url: 'https://kudos.dfo.no/dokument/2021#page=12',
      position: 0,
    },
    {
      chunkId: 'kudos::2021-2',
      text: 'Arbeidet med internkontroll tar utgangspunkt i veilederne fra DFØ.',
      heading: 'Internkontroll og risikovurdering',
      position: 1,
    },
    { chunkId: 'kudos::2021-3', text: 'Ledelsen vurderer måloppnåelsen som god.', position: 2 },
  ],
};

const memo: SourceDocument = {
  index: 2,
  title: 'Internt notat',
  documentId: 'attached:abc',
  excerpts: [{ chunkId: 'attached:abc:0', text: 'Notatet beskriver rutinen.' }],
};

const cite = (...chunks: string[]): SourceCitation[] => chunks.map((chunkId) => ({ chunkId }));

const draw = (props: Partial<SourcesProps> = {}) =>
  render(<Sources sources={[nkom, memo]} corpus="Kudos" {...props} />);

const rowOf = (name: RegExp | string) =>
  screen.getByRole('heading', { name }).closest('.uib-sources-excerpt') as HTMLElement;
const toggleOf = (name: RegExp | string) =>
  within(rowOf(name)).getByRole('button', { name: /^(Åpne|Lukk|Open|Close) / });

describe('the sources block', () => {
  it('names each document by its title and never by a number', () => {
    draw({ citations: cite('kudos::2021-2') });
    const heading = screen.getByRole('heading', { level: 3, name: nkom.title });
    expect(heading.textContent).toBe(nkom.title);
    expect(document.body.textContent).not.toMatch(/\[\d\]|Kilde \d/);
  });

  it('titles an excerpt by its section, with its number before it, as D1 draws it', () => {
    draw({ citations: cite('kudos::2021-1') });
    const title = screen.getByRole('heading', { level: 4, name: /Ressursbruk og måloppnåelse/ });
    expect(title.textContent).toBe('Utdrag 1: Ressursbruk og måloppnåelse');
  });

  it('shows a closed excerpt’s first lines, and all of it once opened', () => {
    draw({ citations: cite('kudos::2021-2') });
    const toggle = toggleOf(/Internkontroll/);
    const quote = () => rowOf(/Internkontroll/).querySelector('.uib-sources-quote') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(quote().classList.contains('uib-sources-preview')).toBe(true);
    expect(quote().textContent).toContain('veilederne fra DFØ');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(toggle.getAttribute('aria-controls') ?? '')).toBe(
      quote().parentElement,
    );
    expect(quote().classList.contains('uib-sources-preview')).toBe(false);
  });

  it('keeps the page link and the actions for an open excerpt', () => {
    draw({ citations: cite('kudos::2021-1'), excerptActions: () => <button>Lagre</button> });
    expect(screen.queryByRole('link', { name: /Les side 12 på Kudos/ })).toBeNull();
    fireEvent.click(toggleOf(/Ressursbruk/));
    expect(screen.getByRole('link', { name: /Les side 12 på Kudos/ }).getAttribute('href')).toBe(
      'https://kudos.dfo.no/dokument/2021#page=12',
    );
    expect(screen.getByRole('button', { name: 'Lagre' })).toBeTruthy();
    expect(screen.getByText('Del III › Ressursbruk og måloppnåelse')).toBeTruthy();
  });
});

describe('numbered excerpts, linked both ways', () => {
  it('numbers only cited excerpts, 1, 2, 3 in the order the answer first cites them', () => {
    draw({ citations: cite('kudos::2021-2', 'kudos::2021-1', 'kudos::2021-2') });
    expect(screen.getByRole('heading', { name: /Utdrag 1.*Internkontroll/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Utdrag 2.*Ressursbruk/ })).toBeTruthy();
    expect(screen.queryByText('Utdrag 3')).toBeNull();
  });

  it('shows an excerpt nothing cites without a number, and says it is not cited', () => {
    draw({ citations: cite('kudos::2021-1') });
    const row = screen
      .getByText('Ledelsen vurderer måloppnåelsen som god.')
      .closest('.uib-sources-excerpt') as HTMLElement;
    expect(within(row).getByRole('heading').textContent).toBe('Utdrag');
    expect(row.dataset.uncited).toBe('true');
    expect(within(row).getByText('Ikke vist til i svaret')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Vis hvor svaret bruker/ })).toBeNull();
  });

  it('numbers nothing and links nothing back without the answer’s footnotes', () => {
    draw({ onShowUse: () => {} });
    expect(screen.queryByText(/^Utdrag \d/)).toBeNull();
    expect(screen.queryByText('Ikke vist til i svaret')).toBeNull();
    expect(screen.queryByRole('button', { name: /Vis hvor svaret bruker/ })).toBeNull();
  });

  it('steps from an excerpt through each place the answer uses it, and wraps', () => {
    const onShowUse = vi.fn();
    draw({ citations: cite('kudos::2021-1', 'kudos::2021-2', 'kudos::2021-1'), onShowUse });
    const back = within(rowOf(/Utdrag 1/)).getByRole('button', {
      name: 'Vis hvor svaret bruker utdrag 1 (1/2)',
    });
    expect(back.textContent).toBe('1/2');
    fireEvent.click(back);
    expect(back.getAttribute('aria-label')).toBe('Vis hvor svaret bruker utdrag 1 (1/2)');
    fireEvent.click(back);
    expect(back.getAttribute('aria-label')).toBe('Vis hvor svaret bruker utdrag 1 (2/2)');
    fireEvent.click(back);
    expect(onShowUse.mock.calls.map(([citation]) => citation)).toEqual([0, 2, 0]);
    expect(onShowUse.mock.calls[0]?.[1]?.excerpt?.chunkId).toBe('kudos::2021-1');
  });

  it('pairs every footnote with a numbered excerpt shown, and every numbered excerpt with a footnote', () => {
    const citations = cite('kudos::2021-3', 'kudos::2021-1', 'kudos::2021-3', 'attached:abc:0');
    draw({ citations, onShowUse: () => {} });
    const pairing = pairCitations([nkom, memo], citations);
    const numbered = screen.getAllByText(/^Utdrag \d+$/).map((label) => label.textContent);
    expect(numbered.sort()).toEqual(
      [...new Set(pairing.numbers.values())].map((n) => `Utdrag ${n}`).sort(),
    );
    for (const label of screen.getAllByText(/^Utdrag \d+$/)) {
      const row = label.closest('.uib-sources-excerpt') as HTMLElement;
      expect(
        within(row).getByRole('button', { name: /^Vis hvor svaret bruker utdrag \d+/ }),
      ).toBeTruthy();
    }
    expect(pairing.unpaired).toEqual([]);
  });
});

describe('document mode', () => {
  const citations: SourceCitation[] = [{ index: 1 }, { index: 1 }];

  it('numbers no excerpt, and links each cited document back to its uses', () => {
    const onShowUse = vi.fn();
    draw({ citations, citationMode: 'document', onShowUse });
    expect(screen.queryByText(/^Utdrag \d/)).toBeNull();
    const back = screen.getByRole('button', {
      name: `Vis hvor svaret bruker ${nkom.title} (1/2)`,
    });
    fireEvent.click(back);
    expect(onShowUse).toHaveBeenCalledWith(0, { source: nkom });
  });

  it('says which documents nothing cites', () => {
    draw({ citations, citationMode: 'document' });
    const card = screen.getByRole('heading', { name: memo.title }).closest('.uib-sources-document');
    expect(within(card as HTMLElement).getByText('Ikke vist til i svaret')).toBeTruthy();
  });

  it('is drawn when the service asks for excerpts but the footnotes name only documents', () => {
    draw({ citations, citationMode: 'excerpt' });
    expect(screen.queryByText(/^Utdrag \d/)).toBeNull();
    expect(screen.getByText('Ikke vist til i svaret')).toBeTruthy();
  });

  it('lets the reader switch modes only when the footnotes name excerpts', () => {
    const onCitationModeChange = vi.fn();
    const { rerender } = draw({ citations, onCitationModeChange });
    expect(screen.queryByRole('radio', { name: 'Dokumenter' })).toBeNull();
    rerender(
      <Sources
        sources={[nkom, memo]}
        citations={cite('kudos::2021-1')}
        onCitationModeChange={onCitationModeChange}
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Dokumenter' }));
    expect(onCitationModeChange).toHaveBeenCalledWith('document');
  });
});

describe('following a footnote', () => {
  it('opens and marks the excerpt it names, moves focus there, and goes back on Escape', async () => {
    const onReturn = vi.fn();
    draw({
      citations: cite('kudos::2021-2'),
      target: { chunkId: 'kudos::2021-2' },
      onReturn,
    });
    await frame();
    const row = rowOf(/Internkontroll/);
    expect(row.dataset.active).toBe('true');
    expect(toggleOf(/Internkontroll/).getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(row);
    expect(within(row).getByRole('button', { name: /Tilbake til svaret/ })).toBeTruthy();
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(onReturn).toHaveBeenCalledOnce();
  });

  it('reports a footnote whose excerpt is not shown, and marks nothing else', async () => {
    const onTargetMissing = vi.fn();
    draw({ target: { chunkId: 'kudos::gone' }, onTargetMissing });
    await frame();
    expect(onTargetMissing).toHaveBeenCalledWith({ chunkId: 'kudos::gone' });
    expect(document.querySelector('[data-active]')).toBeNull();
  });

  it('lands on the document’s heading when the target names only the document', async () => {
    draw({ target: { documentId: 'kudos::2021' }, onReturn: () => {} });
    await frame();
    expect(document.activeElement?.textContent).toBe(nkom.title);
    expect(screen.getByRole('button', { name: /Tilbake til svaret/ })).toBeTruthy();
  });
});

describe('the cards and the search', () => {
  it('lets every document card be closed', () => {
    draw();
    const head = screen.getByRole('button', { name: nkom.title });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(head.getAttribute('aria-controls') ?? '')?.hidden).toBe(true);
  });

  it('finds words across the excerpts, opens the rows that hold them, and counts the hits', () => {
    draw();
    fireEvent.change(screen.getByLabelText('Søk i kildene'), { target: { value: 'dfø' } });
    expect(screen.getByText('1 av 1 treff')).toBeTruthy();
    expect(toggleOf(/Internkontroll/).getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('mark.uib-sources-mark')?.textContent).toBe('DFØ');
  });

  it('gives the reader’s own document no link, and says why', () => {
    draw();
    expect(
      screen.getByText('Bare du har dette dokumentet, så det finnes ingen lenke til det.'),
    ).toBeTruthy();
  });

  it('shows the document and chunk ids behind the info control', () => {
    draw({ details: true });
    const info = screen.getByRole('button', { name: `Detaljer om ${nkom.title}` });
    const region = document.getElementById(info.getAttribute('aria-controls') ?? '');
    expect(region?.hidden).toBe(true);
    fireEvent.click(info);
    expect(region?.hidden).toBe(false);
    expect(within(region as HTMLElement).getByText(/kudos::2021-3/)).toBeTruthy();
  });

  it('tells two documents with one title apart by their number', () => {
    render(
      <Sources
        sources={[
          { ...nkom, documentId: 'kudos::1' },
          { ...nkom, documentId: 'kudos::2', excerpts: [] },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { name: `${nkom.title}, dokument 2` })).toBeTruthy();
  });
});

describe('one answer at a time', () => {
  const stepper = (index: number, onAnswerChange = vi.fn()) =>
    draw({ answerIndex: index, answerCount: 3, onAnswerChange });

  it('says which answer’s sources these are, of how many, and steps with «Forrige» and «Neste»', () => {
    const onAnswerChange = vi.fn();
    stepper(1, onAnswerChange);
    const count = screen.getByText('Kilder til svar 2 av 3', { selector: 'p' });
    expect(count.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Kilder til svar 2 av 3', { selector: 'output' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forrige svar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Neste svar' }));
    expect(onAnswerChange.mock.calls).toEqual([[0], [2]]);
  });

  it('keeps the step at an end focusable but inert, so focus stays where the reader pressed', () => {
    const onAnswerChange = vi.fn();
    stepper(0, onAnswerChange);
    const previous = screen.getByRole('button', { name: 'Forrige svar' });
    expect(previous.getAttribute('aria-disabled')).toBe('true');
    expect(previous.hasAttribute('disabled')).toBe(false);
    fireEvent.click(previous);
    expect(onAnswerChange).not.toHaveBeenCalled();
  });

  it('says the new answer in a live region that is in the page from the start', () => {
    const { rerender } = draw({ answerIndex: 0, answerCount: 1, onAnswerChange: () => {} });
    const region = document.querySelector('output') as HTMLElement;
    expect(region.textContent).toBe('');
    rerender(
      <Sources
        sources={[nkom]}
        corpus="Kudos"
        answerIndex={1}
        answerCount={2}
        onAnswerChange={() => {}}
      />,
    );
    expect(document.querySelector('output')).toBe(region);
    expect(region.textContent).toBe('Kilder til svar 2 av 2');
  });

  it('draws no steps for a thread with one answer, or when the app cannot change answer', () => {
    draw({ answerIndex: 0, answerCount: 1, onAnswerChange: () => {} });
    expect(screen.queryByRole('button', { name: 'Neste svar' })).toBeNull();
    cleanup();
    draw({ answerIndex: 0, answerCount: 3 });
    expect(screen.queryByRole('button', { name: 'Neste svar' })).toBeNull();
  });

  it('starts a fresh search on another answer', () => {
    const { rerender } = draw({ answerIndex: 0, answerCount: 2, onAnswerChange: () => {} });
    const field = screen.getByRole('searchbox') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'internkontroll' } });
    expect(field.value).toBe('internkontroll');
    rerender(
      <Sources
        sources={[nkom, memo]}
        corpus="Kudos"
        answerIndex={1}
        answerCount={2}
        onAnswerChange={() => {}}
      />,
    );
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('');
  });

  it('keeps the steps when the answer on screen has no sources, since stepping back is the point', () => {
    draw({ sources: [], answerIndex: 1, answerCount: 2, onAnswerChange: () => {} });
    expect(screen.getByRole('button', { name: 'Forrige svar' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ingen kilder til dette svaret' })).toBeTruthy();
  });
});

describe('a panel with no sources says why', () => {
  const titleFor = (props: Partial<SourcesProps>) => {
    cleanup();
    draw({ sources: [], ...props });
    return screen.getByRole('heading', { level: 3 }).textContent;
  };

  it('per what became of the answer', () => {
    expect(titleFor({ answerStatus: 'unasked' })).toBe('Ingen kilder ennå');
    expect(titleFor({ answerStatus: 'complete' })).toBe('Ingen kilder til dette svaret');
    expect(titleFor({})).toBe('Ingen kilder til dette svaret');
    expect(titleFor({ answerStatus: 'aborted' })).toBe('Svaret ble avbrutt før kildene kom');
    expect(titleFor({ answerStatus: 'failed' })).toBe('Svaret kom ikke fram');
    expect(titleFor({ answerStatus: 'clarification', assistantName: 'Kunnskapsassistenten' })).toBe(
      'Kunnskapsassistenten spurte om en avklaring',
    );
  });

  it('names the corpus before the first question, and with no answer yet draws no search', () => {
    draw({ sources: undefined, answerStatus: 'unasked' });
    expect(document.body.textContent).toContain(
      'Hvert utdrag er et sitat fra et dokument på Kudos, med samme nummer som markøren i svaret.',
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(document.querySelector('.uib-sources-disclaimer')).toBeNull();
  });

  it('tells sources lost on the way to the store from an answer that cited none', () => {
    const lost = () => {
      cleanup();
      draw({ sources: [], answerStatus: 'complete', citations: cite('kudos::2021-1') });
      return document.body.textContent;
    };
    expect(lost()).toContain('Kildene er ikke lagret for denne samtalen');
    expect(lost()).toContain('Svaret viser til utdrag, men de ble ikke lagret');
    cleanup();
    draw({ sources: [], answerStatus: 'complete', sourcesNotStored: true });
    expect(document.body.textContent).toContain('Kildene blir ikke lagret sammen med samtalen.');
  });

  it('shows the loading state while the answer is still on its way', () => {
    draw({ sources: undefined, answerStatus: 'streaming' });
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('draws nothing when the app passes neither sources nor a status', () => {
    const { container } = draw({ sources: undefined });
    expect(container.innerHTML).toBe('');
  });
});

describe('the catalogue', () => {
  it('speaks English when the reader does', () => {
    render(
      <InLocale locale="en">
        <Sources sources={[nkom]} citations={cite('kudos::2021-1')} onShowUse={() => {}} />
      </InLocale>,
    );
    expect(screen.getByRole('heading', { name: /Excerpt 1.*Ressursbruk/ })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Show where the answer uses excerpt 1' }),
    ).toBeTruthy();
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
