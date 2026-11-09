// @vitest-environment jsdom
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nb as sharedNb } from '../i18n.js';
import { nb as sourcesNb } from '../sources/i18n.js';
import { Sources } from '../sources/Sources.js';
import type { SourceDocument, SourceTarget } from '../sources/types.js';
import { Answer, type AnswerProps, type AnswerTarget } from './Answer.js';
import { answerCitations, type AnswerMarker } from './citations.js';
import { answerCopy, finishedText } from './copy.js';
import { en, nb } from './i18n.js';

document.getAnimations ??= () => [];
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

const nkom: SourceDocument = {
  index: 1,
  title: 'Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
  documentId: 'kudos::2021',
  url: 'https://kudos.dfo.no/dokument/2021',
  excerpts: [
    { chunkId: 'kudos::2021-1', text: 'Nkoms totale utgiftsbevilgning var 594,2 mill. kroner.' },
    { chunkId: 'kudos::2021-2', text: 'Arbeidet med internkontroll tar utgangspunkt i DFØ.' },
    { chunkId: 'kudos::2021-3', text: 'Ledelsen vurderer måloppnåelsen som god.' },
  ],
};

const tildeling: SourceDocument = {
  index: 2,
  title: 'Tildelingsbrev Nkom 2022',
  documentId: 'kudos::2022',
  excerpts: [{ chunkId: 'kudos::2022-1', text: 'Nkom skal rapportere kvartalsvis.' }],
};

const memo: SourceDocument = {
  index: 3,
  title: 'Internt notat',
  documentId: 'attached:abc',
  excerpts: [{ chunkId: 'attached:abc:0', text: 'Notatet beskriver rutinen.' }],
};

const sources = [nkom, tildeling, memo];

const markers: AnswerMarker[] = [
  { marker: '1', chunkId: 'kudos::2022-1', documentId: 'kudos::2022' },
  { marker: '2', chunkId: 'kudos::2021-2', documentId: 'kudos::2021' },
  { marker: '3', chunkId: 'kudos::2021-1', documentId: 'kudos::2021' },
];

const text = [
  '### Rapportering',
  '',
  'Nkom rapporterer kvartalsvis. [1]',
  '',
  'Internkontrollen følger DFØ [2], og bevilgningen var 594,2 mill. kroner [3]. Rapporteringen er fast [1].',
].join('\n');

const draw = (props: Partial<AnswerProps> = {}) =>
  render(<Answer text={text} sources={sources} markers={markers} {...props} />);

// The footnote marks in page order: links when the app gives them somewhere to go, else marks.
const footnotes = () =>
  [...document.querySelectorAll<HTMLElement>('.uib-answer-mark')].filter((mark) =>
    /^Utdrag \d+: /.test(mark.getAttribute('aria-label') ?? ''),
  );

describe('the footnotes in the answer', () => {
  it('numbers only the excerpts the answer cites, 1, 2, 3 in the order it first cites them', () => {
    draw();
    expect(footnotes().map((link) => link.getAttribute('aria-label'))).toEqual([
      'Utdrag 1: Tildelingsbrev Nkom 2022',
      'Utdrag 2: Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
      'Utdrag 3: Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
      'Utdrag 1: Tildelingsbrev Nkom 2022',
    ]);
    expect(footnotes().map((link) => link.textContent)).toEqual(['[1]', '[2]', '[3]', '[1]']);
  });

  it('draws the number in a mark, the brackets kept for copying but out of sight', () => {
    draw();
    const mark = footnotes()[0] as HTMLElement;
    expect(mark.className).toContain('uib-answer-mark');
    expect([...mark.querySelectorAll('.uib-answer-copy')].map((s) => s.textContent)).toEqual([
      '[',
      ']',
    ]);
    expect(mark.getAttribute('title')).toBe(mark.getAttribute('aria-label'));
  });

  it('holds each footnote on the line of the word before it, and the full stop after it', () => {
    const { container } = draw();
    const runs = [...container.querySelectorAll('.uib-markdown-cite-run')];
    expect(runs.map((run) => run.textContent)).toEqual(['. [1]', 'Ø [2],', 'r [3].', 't [1].']);
  });

  it('reports the footnote followed and the excerpt it cites, without following the address', () => {
    const onOpenCitation = vi.fn();
    draw({ onOpenCitation, href: (target) => `#utdrag-${target.chunkId ?? ''}` });
    const third = footnotes()[2] as HTMLElement;
    expect(third.getAttribute('href')).toBe('#utdrag-kudos::2021-1');
    const click = fireEvent.click(third);
    expect(click).toBe(false);
    expect(onOpenCitation).toHaveBeenCalledWith(2, {
      chunkId: 'kudos::2021-1',
      documentId: 'kudos::2021',
      index: 1,
    });
  });

  it('draws no footnote, and guesses no excerpt, when the footnotes name only documents', () => {
    const { container } = render(
      <Answer
        text="Bevilgningen økte [2], og rapporteringen er fast [1]."
        sources={sources}
        onOpenCitation={() => {}}
      />,
    );
    expect(footnotes()).toEqual([]);
    expect(container.querySelector('.uib-answer-mark')).toBeNull();
    expect(container.querySelector('.uib-answer-text')?.textContent).toBe(
      'Bevilgningen økte, og rapporteringen er fast.',
    );
    expect(document.body.textContent).not.toMatch(/Kilde \d|Utdrag \d/);
  });

  it('draws a footnote the app gives nowhere to go as a mark, not a link to the top of the page', () => {
    render(<Answer text={text} sources={sources} markers={markers} />);
    expect(screen.queryAllByRole('link', { name: /^Utdrag \d+: / })).toHaveLength(0);
    const marks = screen.getAllByRole('img', { name: /^Utdrag \d+: / });
    expect(marks.map((mark) => mark.textContent)).toEqual(['[1]', '[2]', '[3]', '[1]']);
    expect(marks[0]?.getAttribute('aria-label')).toBe('Utdrag 1: Tildelingsbrev Nkom 2022');
  });

  it('leaves a [N] no source has as the text it is, and draws a footnote to nothing as nothing', () => {
    const { container } = render(
      <Answer
        text="I [2021] økte det [3]. Men [9] ikke."
        sources={sources}
        markers={[...markers, { marker: '9', chunkId: 'kudos::gone' }]}
      />,
    );
    expect(footnotes()).toHaveLength(1);
    // The service's [3] is the first excerpt the answer cites, so the reader sees 1.
    expect(container.querySelector('.uib-answer-text')?.textContent).toBe(
      'I [2021] økte det [1]. Men ikke.',
    );
  });

  it('keeps the very node a reader pressed when the app draws again', () => {
    const Shell = () => {
      const [chosen, setChosen] = useState<number>();
      return (
        <>
          <p data-testid="chosen">{chosen ?? 'none'}</p>
          <Answer
            text={text}
            sources={[...sources]}
            markers={[...markers]}
            onOpenCitation={(citation) => setChosen(citation)}
          />
        </>
      );
    };
    render(<Shell />);
    const before = footnotes();
    before[0]?.focus();
    fireEvent.click(before[0] as HTMLElement);
    expect(screen.getByTestId('chosen').textContent).toBe('0');
    const after = footnotes();
    after.forEach((node, i) => expect(node).toBe(before[i]));
    expect(document.activeElement).toBe(after[0]);
  });

  it('draws the answer’s headings as headings, from level 3', () => {
    draw();
    expect(screen.getByRole('heading', { name: 'Rapportering' }).tagName).toBe('H5');
  });

  it('puts a wide table in a scroll box named by its columns', () => {
    render(
      <Answer
        text={
          '| Post | 2022 | 2023 | 2024 | 2025 | 2026 |\n|---|---|---|---|---|---|\n| 01 | 1 | 2 | 3 | 4 | 5 |'
        }
        sources={sources}
      />,
    );
    expect(
      screen.getByRole('group', {
        name: 'Tabell med kolonnene Post, 2022, 2023, 2024 og 2 til',
      }).tabIndex,
    ).toBe(0);
  });
});

/**
 * An app as it is meant to wire the two blocks: the same footnotes to both, a footnote's target to
 * Sources, and Sources' way back to the answer's target.
 */
const Host = ({ cites = 'excerpts' }: { cites?: 'excerpts' | 'documents' }) => {
  const named = cites === 'excerpts' ? markers : undefined;
  const citations = useMemo(() => answerCitations(text, sources, named), [named]);
  const [toSource, setToSource] = useState<SourceTarget>();
  const [toAnswer, setToAnswer] = useState<AnswerTarget>();
  // What the reader followed, a footnote or a link in the summary, is where the way back goes.
  const [followed, setFollowed] = useState<AnswerTarget>();
  return (
    <>
      <Answer
        text={text}
        sources={sources}
        markers={named}
        target={toAnswer}
        onOpenCitation={(citation, target) => {
          setFollowed({ citation });
          setToSource(target);
        }}
        onOpenDocument={(source) => {
          const goal = { documentId: source.documentId, index: source.index };
          setFollowed({ document: goal });
          setToSource(goal);
        }}
        onOpenExcerpt={(goal) => {
          setFollowed({ document: goal });
          setToSource(goal);
        }}
      />
      <Sources
        sources={sources}
        citations={citations}
        target={toSource}
        onShowUse={(citation) => setToAnswer({ citation })}
        onReturn={() => {
          if (followed !== undefined) setToAnswer({ ...followed });
        }}
      />
    </>
  );
};

// «Utdrag n» in Sources: the excerpt's title, a link back when the app takes one.
const numberSelector = '.uib-sources-excerpt-number';
const excerptRow = (n: number) =>
  screen
    .getByText(`Utdrag ${n}`, { selector: numberSelector })
    .closest('.uib-sources-excerpt') as HTMLElement;

describe('the pairing, both ways, between the answer and Sources', () => {
  it('pairs every footnote with an excerpt shown under its number, and every numbered excerpt with a footnote', async () => {
    render(<Host />);
    const inAnswer = new Set(
      footnotes().map((link) => /^Utdrag (\d+)/.exec(link.getAttribute('aria-label') ?? '')?.[1]),
    );
    const inSources = new Set(
      screen
        .getAllByText(/^Utdrag \d+$/, { selector: `.uib-sources-excerpt ${numberSelector}` })
        .map((label) => label.textContent?.slice('Utdrag '.length)),
    );
    expect([...inAnswer].sort()).toEqual(['1', '2', '3']);
    expect([...inSources].sort()).toEqual([...inAnswer].sort());
    // Footnote n leads to «Utdrag n», each one followed.
    for (const footnote of footnotes()) {
      fireEvent.click(footnote);
      await frame();
      const n = /^Utdrag (\d+)/.exec(footnote.getAttribute('aria-label') ?? '')?.[1];
      expect(
        document.activeElement?.querySelector('.uib-sources-excerpt-number')?.textContent,
      ).toBe(`Utdrag ${n}`);
    }
    // The excerpt nothing cites is shown without a number, and says so.
    const uncited = screen
      .getByText('Ledelsen vurderer måloppnåelsen som god.')
      .closest('.uib-sources-excerpt') as HTMLElement;
    expect(uncited.dataset.uncited).toBe('true');
    expect(uncited.querySelector(numberSelector)).toBeNull();
  });

  it('leads from a footnote to its excerpt, opened, marked and focused', async () => {
    render(<Host />);
    fireEvent.click(footnotes()[2] as HTMLElement);
    await frame();
    const row = excerptRow(3);
    expect(row.dataset.active).toBe('true');
    expect(document.activeElement).toBe(row);
    expect(row.textContent).toContain('594,2 mill. kroner');
  });

  it('leads from the links beside an excerpt’s title back to each footnote that cites it', async () => {
    render(<Host />);
    const back = within(excerptRow(1)).getAllByRole('link', { name: /^\d+: fotnote \d/ });
    expect(back.map((link) => link.textContent)).toEqual(['1', '2']);
    expect(back.map((link) => link.getAttribute('aria-label'))).toEqual([
      '1: fotnote 1, første sted i svaret',
      '2: fotnote 1, andre sted i svaret',
    ]);
    fireEvent.click(back[1] as HTMLElement);
    await frame();
    expect(document.activeElement).toBe(footnotes()[3]);
    fireEvent.click(back[0] as HTMLElement);
    await frame();
    expect(document.activeElement).toBe(footnotes()[0]);
    fireEvent.click(back[1] as HTMLElement);
    await frame();
    expect(document.activeElement).toBe(footnotes()[3]);
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Utdrag 1: Tildelingsbrev Nkom 2022',
    );
  });

  it('goes back to the footnote the reader followed', async () => {
    render(<Host />);
    fireEvent.click(footnotes()[3] as HTMLElement);
    await frame();
    fireEvent.keyDown(excerptRow(1), { key: 'Escape' });
    await frame();
    expect(document.activeElement).toBe(footnotes()[3]);
  });

  it('goes back to the title in «Kilder brukt i svaret» the reader came from, by Escape or the button', async () => {
    render(<Host />);
    // A footnote first, so a stale way back would show.
    fireEvent.click(footnotes()[0] as HTMLElement);
    await frame();
    const title = screen.getByRole('link', { name: tildeling.title });
    fireEvent.click(title);
    await frame();
    const card = screen
      .getByRole('heading', { level: 3, name: tildeling.title })
      .closest('.uib-sources-document') as HTMLElement;
    expect(card.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await frame();
    expect(document.activeElement).toBe(title);
    fireEvent.click(title);
    await frame();
    fireEvent.click(within(card).getByRole('button', { name: 'Tilbake til svaret' }));
    await frame();
    expect(document.activeElement).toBe(title);
  });

  it('goes from «Utdrag 2» in «Kilder brukt i svaret» to that excerpt in Sources, and back to the link', async () => {
    render(<Host />);
    const link = screen.getByRole('link', { name: 'Utdrag 2 i Kilder' });
    fireEvent.click(link);
    await frame();
    const row = excerptRow(2);
    expect(row.dataset.active).toBe('true');
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: 'Escape' });
    await frame();
    expect(document.activeElement).toBe(link);
  });

  it('numbers nothing on either side when the footnotes name only documents, and still lists the documents', () => {
    render(<Host cites="documents" />);
    expect(footnotes()).toEqual([]);
    expect(document.body.textContent).not.toMatch(/Kilde \d|Utdrag \d/);
    expect(screen.queryAllByRole('link', { name: /fotnote \d|i Kilder$/i })).toEqual([]);
    expect(screen.getByRole('link', { name: nkom.title })).toBeTruthy();
    expect(screen.getByRole('link', { name: tildeling.title })).toBeTruthy();
  });
});

describe('«Kilder brukt i svaret»', () => {
  const rows = () =>
    within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((row) => row.textContent);

  it('lists each document the answer cites, by its numbers as Sources runs them, with its excerpts', () => {
    // The service lists the annual report first, but the letter holds «Utdrag 1».
    draw();
    expect(screen.getByText('Kilder brukt i svaret').closest('details')?.open).toBe(true);
    expect(rows()).toEqual([
      'Tildelingsbrev Nkom 2022Utdrag 1',
      'Årsrapport Nasjonal kommunikasjonsmyndighet 2021Utdrag 2, Utdrag 3',
    ]);
  });

  it('runs in the same order as the cards in Sources, and so do the excerpts under each title', () => {
    // The annual report cites its second excerpt before its first: «Utdrag 2, Utdrag 3» both here
    // and in its card, where the excerpt nothing cites comes after them.
    render(<Host />);
    const summary = screen.getByText('Kilder brukt i svaret').closest('details') as HTMLElement;
    const listed = within(summary)
      .getAllByRole('listitem')
      .map((row) => [
        row.querySelector('.uib-answer-sources-used-link')?.textContent,
        [...row.querySelectorAll('.uib-answer-sources-used-excerpt')].map((e) => e.textContent),
      ]);
    const cards = [...document.querySelectorAll('.uib-sources-document')].map((card) => [
      card.querySelector('h3')?.textContent,
      [...card.querySelectorAll('.uib-sources-excerpt:not([data-uncited])')].map(
        (row) => row.querySelector('.uib-sources-excerpt-number')?.textContent,
      ),
    ]);
    expect(listed).toEqual([
      ['Tildelingsbrev Nkom 2022', ['Utdrag 1']],
      ['Årsrapport Nasjonal kommunikasjonsmyndighet 2021', ['Utdrag 2', 'Utdrag 3']],
    ]);
    expect(cards.filter(([title]) => listed.some(([name]) => name === title))).toEqual(listed);
  });

  it('names each excerpt under its title, in order, comma separated, on one small grey line', () => {
    render(
      <Answer
        text="A [3]. B [1]. C [2]."
        sources={sources}
        markers={[...markers.slice(0, 2), { marker: '3', chunkId: 'kudos::2021-3' }]}
      />,
    );
    expect(rows()).toEqual([
      'Årsrapport Nasjonal kommunikasjonsmyndighet 2021Utdrag 1, Utdrag 3',
      'Tildelingsbrev Nkom 2022Utdrag 2',
    ]);
    const line = screen.getAllByRole('listitem')[0]?.querySelector('p') as HTMLElement;
    expect(line.className).toContain('uib-answer-sources-used-excerpts');
    expect(line.dataset.size).toBe('xs');
  });

  it('makes each excerpt a link to it in Sources, named for a screen reader', () => {
    const onOpenExcerpt = vi.fn();
    draw({ onOpenExcerpt, href: (target) => `#utdrag-${target.chunkId ?? ''}` });
    const links = screen.getAllByRole('link', { name: /^Utdrag \d+ i Kilder$/ });
    expect(links.map((link) => link.textContent)).toEqual(['Utdrag 1', 'Utdrag 2', 'Utdrag 3']);
    expect(links[2]?.getAttribute('href')).toBe('#utdrag-kudos::2021-1');
    expect(fireEvent.click(links[2] as HTMLElement)).toBe(false);
    expect(onOpenExcerpt).toHaveBeenCalledWith({
      chunkId: 'kudos::2021-1',
      documentId: 'kudos::2021',
      index: 1,
    });
  });

  it('lists the documents an answer cites only as wholes, with no excerpts under them', () => {
    draw({ markers: undefined, onOpenExcerpt: () => {} });
    expect(rows()).toEqual([nkom.title, tildeling.title, `${memo.title}, ditt dokument`]);
    expect(screen.queryByText(/Utdrag/)).toBeNull();
  });

  it('opens the document itself, not its first excerpt', () => {
    const onOpenDocument = vi.fn();
    draw({ onOpenDocument });
    fireEvent.click(screen.getByRole('link', { name: tildeling.title }));
    expect(onOpenDocument).toHaveBeenCalledWith(tildeling);
  });

  it('says that the reader’s own document is theirs, without changing what is seen', () => {
    render(
      <Answer
        text="Rutinen [1]."
        sources={sources}
        markers={[{ marker: '1', chunkId: 'attached:abc:0' }]}
        onOpenDocument={() => {}}
      />,
    );
    const link = screen.getByRole('link', { name: 'Internt notat, ditt dokument' });
    expect(link.textContent).toBe('Internt notat');
    // Named in one piece, so no browser reads a space before the comma.
    expect(link.getAttribute('aria-label')).toBe('Internt notat, ditt dokument');
    expect(link.querySelector('.ds-sr-only')).toBeNull();
  });

  it('tells two documents with one title apart', () => {
    render(
      <Answer
        text="A [1]. B [2]."
        sources={[
          { ...nkom, documentId: 'kudos::90777' },
          { ...nkom, index: 2, documentId: 'kudos::88640' },
        ]}
        onOpenDocument={() => {}}
      />,
    );
    expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
      `${nkom.title}, dokument 90777`,
      `${nkom.title}, dokument 88640`,
    ]);
  });

  it('comes only once the answer is done, and not when it was stopped', () => {
    draw({ status: 'streaming' });
    expect(screen.queryByText('Kilder brukt i svaret')).toBeNull();
    cleanup();
    draw({ status: 'aborted' });
    expect(screen.queryByText('Kilder brukt i svaret')).toBeNull();
  });
});

describe('the answer’s states', () => {
  it('says who answered, to a screen reader, as made by an AI assistant', () => {
    draw();
    expect(screen.getByText('KI-assistenten svarte:').className).toBe('ds-sr-only');
    cleanup();
    draw({ assistantName: 'Kunnskapsassistenten' });
    expect(screen.getByText('Kunnskapsassistenten svarte:')).toBeTruthy();
  });

  it('shows a skeleton before the first word, and a quiet line while it writes', () => {
    const { container } = draw({ status: 'streaming', text: '', sources: undefined });
    expect(container.querySelector('.uib-answer-skeleton')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    cleanup();
    draw({ status: 'streaming', sources: undefined, markers: undefined });
    expect(screen.getByText('Skriver svar …').getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('says a stopped answer’s sources never came, at each footnote and under the text', () => {
    const onRegenerate = vi.fn();
    const { container } = draw({
      status: 'aborted',
      sources: undefined,
      markers: undefined,
      onRegenerate,
    });
    const lost = [...container.querySelectorAll('.uib-answer-lost')];
    expect(lost.map((mark) => mark.getAttribute('title'))).toEqual([
      'Kilden kom ikke fram',
      'Kilden kom ikke fram',
      'Kilden kom ikke fram',
      'Kilden kom ikke fram',
    ]);
    expect(lost[0]?.textContent).toBe('[1] (kilden kom ikke fram)');
    expect(screen.getByText('Svaret ble avbrutt, så kildene bak det kom aldri fram.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Generer på nytt' }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });

  it('names what there was when the search was stopped before the answer began', () => {
    draw({ status: 'aborted', text: '' });
    expect(screen.getByText('Du stoppet søket før svaret begynte.')).toBeTruthy();
  });

  it('says a failed answer failed, and draws no card for an empty finished one', () => {
    draw({ status: 'failed', text: '' });
    expect(
      screen.getByText('Dette spørsmålet fikk ikke noe svar. Noe gikk galt underveis.'),
    ).toBeTruthy();
    cleanup();
    const { container } = draw({ text: '' });
    expect(container.childElementCount).toBe(0);
  });

  it('warns over a finished answer with no sources, and only then', () => {
    render(<Answer text="Kildene dekker ikke dette." sources={[]} />);
    expect(
      screen.getByText(
        'Svaret har ingen kilder. Kontroller det mot originaldokumentene før du bruker det.',
      ),
    ).toBeTruthy();
    cleanup();
    for (const props of [
      { sources: undefined },
      { sources: [], text: 'Footnotes whose sources were lost [1].' },
      { sources: [], noAnswer: true },
      { sources: [], status: 'streaming' as const },
    ]) {
      render(<Answer text="Kildene dekker ikke dette." {...props} />);
      expect(screen.queryByText(/^Svaret har ingen kilder/)).toBeNull();
      cleanup();
    }
  });

  it('ends with the closing question and the actions only when asked, and only when done', () => {
    draw({ closingQuestion: true, actions: <button type="button">Kopier svaret</button> });
    expect(screen.getByText('Er det noe mer jeg kan hjelpe deg med?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Kopier svaret' })).toBeTruthy();
    cleanup();
    draw({ noAnswer: true, closingQuestion: true });
    expect(screen.queryByText('Er det noe mer jeg kan hjelpe deg med?')).toBeNull();
    expect(screen.queryByText('Kilder brukt i svaret')).toBeNull();
  });
});

describe('a failed answer', () => {
  it('draws no text, only its own failure, since genki streams its error message as text', () => {
    draw({ status: 'failed', text: 'Error: the service failed' });
    expect(screen.queryByText(/Error: the service failed/)).toBeNull();
    expect(
      screen.getByText('Dette spørsmålet fikk ikke noe svar. Noe gikk galt underveis.'),
    ).toBeTruthy();
  });

  it('is drawn as the app passes it, also after a reload, failed or stopped', () => {
    draw({ status: 'failed', text: '', onRegenerate: () => {} });
    expect(screen.getByRole('button', { name: 'Generer på nytt' })).toBeTruthy();
    cleanup();
    draw({ status: 'aborted', onRegenerate: () => {} });
    expect(screen.getByText(/Svaret ble avbrutt/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generer på nytt' })).toBeTruthy();
  });

  it('says which failure it was, what happened and what to do', () => {
    draw({ status: 'failed', text: '', failure: { kind: 'timeout' }, onRegenerate: () => {} });
    expect(screen.getByText('Svaret tok for lang tid')).toBeTruthy();
    expect(
      screen.getByText(
        'Spørsmålet ble avbrutt fordi svaret brukte for lang tid. Et mer avgrenset spørsmål, eller et smalere filter, går som regel raskere.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });

  it('puts the service’s own sentence first, without a second «Prøv igjen», and keeps the advice', () => {
    draw({
      status: 'failed',
      text: '',
      failure: { kind: 'model', message: 'Modellen er utilgjengelig. Prøv igjen.' },
    });
    expect(
      screen.getByText(
        'Modellen er utilgjengelig. Dokumentene og filteret er uberørt, så spørsmålet kan stilles som det står.',
      ),
    ).toBeTruthy();
  });

  it('offers to ask again only when that can help', () => {
    const offered = (kind: NonNullable<AnswerProps['failure']>['kind']) => {
      cleanup();
      draw({ status: 'failed', text: '', failure: { kind }, onRegenerate: () => {} });
      return screen.queryByRole('button', { name: 'Prøv igjen' }) !== null;
    };
    expect(
      ['model', 'search', 'timeout', 'busy', 'unknown'].map((k) => offered(k as never)),
    ).toEqual([true, true, true, true, true]);
    expect(['access', 'tooLong', 'filter', 'threadGone'].map((k) => offered(k as never))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('names the assistant where the case does', () => {
    draw({
      status: 'failed',
      text: '',
      failure: { kind: 'search' },
      assistantName: 'Kunnskapsassistenten',
    });
    expect(
      screen.getByText(/^Kunnskapsassistenten fikk ikke søkt i dokumentene/).textContent,
    ).toContain('ingenting å bygge på');
  });

  it('announces a failure that ends an answer on its way, and moves lost focus to «Prøv igjen»', async () => {
    const { rerender } = draw({ status: 'streaming', text: '', onRegenerate: () => {} });
    const region = screen.getByRole('alert');
    expect(region.textContent).toBe('');
    rerender(
      <Answer
        text=""
        status="failed"
        failure={{ kind: 'busy' }}
        sources={sources}
        markers={markers}
        onRegenerate={() => {}}
      />,
    );
    expect(screen.getByRole('alert')).toBe(region);
    expect(region.textContent).toContain('For mange spørsmål på kort tid');
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Prøv igjen' }));
  });

  it('shows a failure read back from the store without announcing it, and keeps focus', async () => {
    draw({ status: 'failed', text: '', failure: { kind: 'busy' }, onRegenerate: () => {} });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('For mange spørsmål på kort tid')).toBeTruthy();
    await frame();
    expect(document.activeElement).toBe(document.body);
  });

  it('says only that it failed, and offers «Generer på nytt», when the app cannot tell why', () => {
    draw({ status: 'failed', text: '', onRegenerate: () => {} });
    expect(
      screen.getByText('Dette spørsmålet fikk ikke noe svar. Noe gikk galt underveis.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generer på nytt' })).toBeTruthy();
  });
});

describe('the answer as copied', () => {
  const year = { ...nkom, publishedAt: '2022-03-01' };
  const paged = {
    ...year,
    excerpts: year.excerpts.map((e, i) => (i === 0 ? { ...e, page: 12 } : e)),
  };

  it('numbers its footnotes as drawn and lists one reference per excerpt under «Kilder»', () => {
    const copied = answerCopy(text, { sources: [paged, tildeling, memo], markers });
    expect(copied.sources).toBe(3);
    expect(copied.text).toBe(
      [
        'Rapportering',
        '',
        'Nkom rapporterer kvartalsvis. [1]',
        '',
        'Internkontrollen følger DFØ [2], og bevilgningen var 594,2 mill. kroner [3]. Rapporteringen er fast [1].',
        '',
        'Kilder',
        '[1] Tildelingsbrev Nkom 2022.',
        '[2] Årsrapport Nasjonal kommunikasjonsmyndighet 2021 (2022). https://kudos.dfo.no/dokument/2021',
        '[3] Årsrapport Nasjonal kommunikasjonsmyndighet 2021, s. 12 (2022). https://kudos.dfo.no/dokument/2021',
      ].join('\n'),
    );
  });

  it('copies an answer that cites only documents as drawn, without footnotes, one unnumbered line per document', () => {
    const copied = answerCopy(text, { sources });
    // Without markers, [N] is the source with index N: all three documents.
    expect(copied.sources).toBe(3);
    expect(copied.text).toContain('Nkom rapporterer kvartalsvis.\n');
    expect(copied.text).toContain('Internkontrollen følger DFØ, og bevilgningen');
    expect(copied.text).not.toMatch(/\[\d\]/);
    expect(copied.text.split('Kilder\n')[1]).toBe(
      'Årsrapport Nasjonal kommunikasjonsmyndighet 2021. https://kudos.dfo.no/dokument/2021\nTildelingsbrev Nkom 2022.\nInternt notat.',
    );
  });

  it('is the clean text alone, without footnotes, when no source came', () => {
    const copied = answerCopy('Svaret står her [1].\n\n- Et punkt', {});
    expect(copied).toEqual({ text: 'Svaret står her.\n\nEt punkt', sources: 0 });
  });

  it('gives a live region only the finished blocks of an answer on its way, without footnotes', () => {
    expect(finishedText('Nkom rapporterer')).toBe('');
    expect(finishedText('### Rapportering\n\nNkom rapporterer [1].\n\nInternkontrollen føl')).toBe(
      'Rapportering\n\nNkom rapporterer.',
    );
  });

  it('announces and copies the words drawn, with no inline Markdown: emphasis, code and links', () => {
    const markdown = [
      'Digdirs årsrapport sier at **Altinn 3 utgjorde 14 prosent** av trafikken [1].',
      '',
      '- Se _veilederen_ og [rapporten](https://kudos.dfo.no/dokument/2021), kjør `npm ci`, ikke ~~før~~.',
      '',
      '| **År** | Andel |',
      '| --- | --- |',
      '| 2024 | *14* % |',
      '',
      'Neste avsnitt skrives',
    ].join('\n');
    const said = finishedText(markdown);
    expect(said).toBe(
      [
        'Digdirs årsrapport sier at Altinn 3 utgjorde 14 prosent av trafikken.',
        '',
        'Se veilederen og rapporten, kjør npm ci, ikke før.',
        '',
        'År\tAndel',
        '2024\t14 %',
      ].join('\n'),
    );
    expect(said).not.toMatch(/[*_`~[\]]/);
    // The clipboard gets the same words, its footnotes numbered as drawn.
    expect(answerCopy(markdown, { sources }).text).toContain(
      'Digdirs årsrapport sier at Altinn 3 utgjorde 14 prosent av trafikken.',
    );
    // A code block's lines stay as written, without the fences; a `*` between spaces is prose.
    expect(finishedText('```\nconst a = **b**;\n```\n\n2 * 3 * 4 er 24\n\nslutt')).toBe(
      'const a = **b**;\n\n2 * 3 * 4 er 24',
    );
  });

  it('writes the reference list in the reader’s language', () => {
    expect(answerCopy(text, { sources: [paged], markers, locale: 'en' }).text).toContain(
      'Sources\n[1] Årsrapport Nasjonal kommunikasjonsmyndighet 2021 (2022).',
    );
    expect(answerCopy(text, { sources: [paged], markers, locale: 'en' }).text).toContain(
      ', p. 12 (2022).',
    );
  });
});

describe('the catalogue', () => {
  it('speaks English when the reader does', () => {
    render(
      <InLocale locale="en">
        <Answer text={text} sources={sources} markers={markers} />
      </InLocale>,
    );
    expect(
      screen.getAllByRole('img', { name: /^Excerpt 1: Tildelingsbrev/ }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Sources used in the answer')).toBeTruthy();
    expect(screen.getByText('Excerpt 2, Excerpt 3')).toBeTruthy();
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('keeps its words to itself, out of the shared catalogue that Approach loads', () => {
    expect(Object.keys(nb)).toEqual(['answer', 'sources']);
    expect(sharedNb).not.toHaveProperty('answer');
    // The words it shares with Sources are Sources' own, not a copy.
    expect(nb.sources).toBe(sourcesNb.sources);
  });
});
