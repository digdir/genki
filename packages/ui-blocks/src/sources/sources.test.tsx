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
  it('heads its documents with «Kilder» one level up, as kunnskapsassistenten’s outline does', () => {
    draw({ citations: cite('kudos::2021-1') });
    expect(screen.getByRole('heading', { level: 2, name: 'Kilder' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: nkom.title })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: /^Utdrag 1/ })).toBeTruthy();
    cleanup();
    draw({ headingLevel: 4 });
    expect(screen.getByRole('heading', { level: 3, name: 'Kilder' })).toBeTruthy();
  });

  it('names each document by its title and never by a number', () => {
    draw({ citations: cite('kudos::2021-2') });
    const heading = screen.getByRole('heading', { level: 3, name: nkom.title });
    expect(heading.textContent).toBe(nkom.title);
    expect(document.body.textContent).not.toMatch(/\[\d\]|Kilde \d/);
  });

  it('titles an excerpt by its section, with its number before it, as D1 draws it', () => {
    draw({ citations: cite('kudos::2021-1') });
    const title = screen.getByRole('heading', {
      level: 4,
      name: 'Utdrag 1: Ressursbruk og måloppnåelse',
    });
    expect([...title.children].map((part) => part.textContent)).toEqual([
      'Utdrag 1',
      'Ressursbruk og måloppnåelse',
    ]);
    // The heading keeps its name when its number is a link back.
    cleanup();
    draw({ citations: cite('kudos::2021-1'), onShowUse: () => {} });
    expect(
      screen.getByRole('heading', { level: 4, name: 'Utdrag 1: Ressursbruk og måloppnåelse' }),
    ).toBeTruthy();
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
    expect(within(row).queryByRole('link', { name: /til svaret/i })).toBeNull();
  });

  it('numbers nothing and links nothing back without the answer’s footnotes', () => {
    draw({ onShowUse: () => {} });
    expect(screen.queryByText(/^Utdrag \d/)).toBeNull();
    expect(screen.queryByText('Ikke vist til i svaret')).toBeNull();
    expect(screen.queryByRole('link', { name: /til svaret/i })).toBeNull();
  });
});

describe('the way back to the answer, where the excerpt is', () => {
  const links = (row: HTMLElement) => within(row).getAllByRole('link', { name: /til svaret/i });

  it('makes the title of an excerpt cited once the link to its footnote, saying which footnote', () => {
    const onShowUse = vi.fn();
    draw({ citations: cite('kudos::2021-1', 'kudos::2021-2', 'kudos::2021-1'), onShowUse });
    const row = rowOf(/Utdrag 2/);
    const [title, ...more] = links(row);
    expect(more).toEqual([]);
    expect(title?.closest('h4')).toBe(row.querySelector('h4'));
    // What is seen starts the name (WCAG 2.5.3).
    expect(title?.textContent).toBe('Utdrag 2');
    expect(title?.getAttribute('aria-label')).toBe('Utdrag 2, til svaret, fotnote 2 av 3');
    fireEvent.click(title as HTMLElement);
    expect(onShowUse).toHaveBeenCalledWith(1, { source: nkom, excerpt: nkom.excerpts[1] });
  });

  it('leads the title of an excerpt cited three times to the first use, and «↩ 2 3» beside it to the others', () => {
    const onShowUse = vi.fn();
    draw({
      citations: cite('kudos::2021-1', 'kudos::2021-2', 'kudos::2021-1', 'kudos::2021-1'),
      onShowUse,
    });
    const row = rowOf(/Utdrag 1/);
    const all = links(row);
    expect(all.map((link) => link.textContent)).toEqual(['Utdrag 1', '2', '3']);
    expect(all.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Utdrag 1, til svaret, bruk 1, fotnote 1 av 4',
      'Til svaret, bruk 2, fotnote 3 av 4',
      'Til svaret, bruk 3, fotnote 4 av 4',
    ]);
    // All three in the title's line, in the answer's order.
    const line = row.querySelector('.uib-sources-excerpt-number') as HTMLElement;
    for (const link of all) expect(line.contains(link)).toBe(true);
    for (const link of [all[2], all[0], all[1]]) fireEvent.click(link as HTMLElement);
    expect(onShowUse.mock.calls.map(([citation]) => citation)).toEqual([3, 0, 2]);
  });

  it('draws no control for the way back at the top: not on a document’s head, nor over the list', () => {
    draw({
      citations: cite('kudos::2021-1', 'kudos::2021-1', 'kudos::2021-2', 'attached:abc:0'),
      onShowUse: () => {},
    });
    for (const head of document.querySelectorAll<HTMLElement>(
      '.uib-sources-head, .uib-sources-document-head',
    ))
      expect(within(head).queryByRole('link')).toBeNull();
    // Every link back is in an excerpt's title.
    for (const link of screen.getAllByRole('link', { name: /til svaret/i }))
      expect(link.closest('.uib-sources-excerpt-title')).toBeTruthy();
  });

  it('makes each link back a real link to the footnote’s address, which the app passes', () => {
    draw({
      citations: cite('kudos::2021-1', 'kudos::2021-1'),
      citationHref: (citation) => `#fotnote-${citation}`,
    });
    expect(links(rowOf(/Utdrag 1/)).map((link) => link.getAttribute('href'))).toEqual([
      '#fotnote-0',
      '#fotnote-1',
    ]);
  });

  it('keeps each link back at least 24 px both ways, by its class', () => {
    draw({ citations: cite('kudos::2021-1', 'kudos::2021-1'), onShowUse: () => {} });
    for (const link of links(rowOf(/Utdrag 1/)))
      expect(link.classList.contains('uib-sources-use')).toBe(true);
  });

  it('says which answer a link leads to when the thread has several', () => {
    draw({
      citations: cite('kudos::2021-1'),
      onShowUse: () => {},
      answerIndex: 1,
      answerCount: 3,
      onAnswerChange: () => {},
    });
    expect(
      screen.getByRole('link', { name: 'Utdrag 1, til svaret, fotnote 1 av 1 i svar 2' }),
    ).toBeTruthy();
  });

  it('pairs every footnote with a numbered excerpt shown, and every numbered excerpt with a footnote', () => {
    const citations = cite('kudos::2021-3', 'kudos::2021-1', 'kudos::2021-3', 'attached:abc:0');
    draw({ citations, onShowUse: () => {} });
    const pairing = pairCitations([nkom, memo], citations);
    const numbered = screen.getAllByText(/^Utdrag \d+$/).map((label) => label.textContent);
    expect(numbered.sort()).toEqual(
      [...new Set(pairing.numbers.values())].map((n) => `Utdrag ${n}`).sort(),
    );
    for (const label of screen.getAllByText(/^Utdrag \d+$/)) expect(label.matches('a')).toBe(true);
    expect(pairing.unpaired).toEqual([]);
  });
});

describe('footnotes that name only documents', () => {
  const citations: SourceCitation[] = [{ index: 1 }, { index: 1 }];

  const cardOf = (title: string) =>
    screen
      .getByRole('heading', { name: new RegExp(`${title}$`) })
      .closest('.uib-sources-document') as HTMLElement;

  it('number nothing, neither the documents nor a guessed excerpt, and link nothing back', () => {
    const tildeling: SourceDocument = {
      index: 4,
      title: 'Tildelingsbrev Nkom 2022',
      documentId: 'kudos::2022',
      excerpts: [{ chunkId: 'kudos::2022-1', text: 'Nkom skal rapportere kvartalsvis.' }],
    };
    draw({
      sources: [nkom, tildeling, memo],
      citations: [{ index: 4 }, { index: 1 }, { index: 4 }],
      onShowUse: () => {},
    });
    expect(screen.getByRole('heading', { level: 3, name: tildeling.title })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: nkom.title })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Kilde \d|Utdrag \d/);
    expect(screen.queryByRole('link', { name: /til svaret/i })).toBeNull();
  });

  it('number nothing even when some footnotes name excerpts', () => {
    draw({ citations: [{ chunkId: 'kudos::2021-1' }, { index: 2 }], onShowUse: () => {} });
    expect(document.body.textContent).not.toMatch(/Kilde \d|Utdrag \d/);
  });

  it('keep the passages, which nothing cites alone, unnumbered and closed behind one button', () => {
    draw({ citations });
    const card = cardOf(nkom.title);
    const toggle = within(card).getByRole('button', { name: 'Vis utdrag fra dokumentet (3)' });
    const passages = card.querySelector('.uib-sources-passages') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(passages.id);
    expect(passages.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(passages.hidden).toBe(false);
    expect(toggle.textContent).toBe('Skjul utdrag fra dokumentet (3)');
    expect(within(passages).queryByText(/^Utdrag \d/)).toBeNull();
  });

  it('show the passages that hold a search hit', () => {
    draw({ citations });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'internkontroll' } });
    expect((cardOf(nkom.title).querySelector('.uib-sources-passages') as HTMLElement).hidden).toBe(
      false,
    );
  });

  it('say which documents no footnote names', () => {
    draw({ citations });
    const card = screen.getByRole('heading', { name: memo.title }).closest('.uib-sources-document');
    expect(within(card as HTMLElement).getByText('Ikke vist til i svaret')).toBeTruthy();
    expect(within(cardOf(nkom.title)).queryByText('Ikke vist til i svaret')).toBeNull();
  });

  it('offer no switch to number documents', () => {
    draw({ citations: cite('kudos::2021-1') });
    expect(screen.queryByRole('radio')).toBeNull();
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

  it('follows a target once, so new sources with the target still held move no focus', async () => {
    const target = { documentId: 'kudos::2021' };
    const { rerender } = render(<Sources sources={[nkom, memo]} target={target} />);
    await frame();
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    // Another answer's sources: every card remounts, with the same target object still passed.
    const again = { ...nkom, excerpts: nkom.excerpts.slice(0, 1) };
    rerender(<Sources sources={[again, memo]} target={target} />);
    await frame();
    expect(document.activeElement).toBe(outside);
    // A new target object, as a new footnote press gives, is followed.
    rerender(<Sources sources={[again, memo]} target={{ documentId: 'kudos::2021' }} />);
    await frame();
    expect(document.activeElement?.textContent).toBe(nkom.title);
    outside.remove();
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
    // «Kilder» only: no empty state under it.
    expect(screen.getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Kilder',
    ]);
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
      screen.getByRole('link', { name: 'Excerpt 1, to the answer, footnote 1 of 1' }),
    ).toBeTruthy();
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
