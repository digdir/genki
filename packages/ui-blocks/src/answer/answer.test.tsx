// @vitest-environment jsdom
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useMemo, useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { en, nb } from '../i18n.js';
import { Sources } from '../sources/Sources.js';
import type { SourceDocument, SourceTarget } from '../sources/types.js';
import { Answer, type AnswerProps, type AnswerTarget } from './Answer.js';
import { answerCitations, type AnswerMarker } from './citations.js';

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

const footnotes = () => screen.getAllByRole('link', { name: /^(Utdrag \d+|Kilde): / });

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

  it('names a document by its title in document mode, and numbers nothing', () => {
    draw({ citationMode: 'document' });
    expect(footnotes().map((link) => link.getAttribute('aria-label'))).toEqual([
      'Kilde: Tildelingsbrev Nkom 2022',
      'Kilde: Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
      'Kilde: Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
      'Kilde: Tildelingsbrev Nkom 2022',
    ]);
    expect(document.body.textContent).not.toMatch(/Utdrag \d/);
  });

  it('reads [N] as the source with that index when the service cites documents', () => {
    render(
      <Answer text="Bevilgningen økte [1], og rapporteringen er fast [2]." sources={sources} />,
    );
    expect(footnotes().map((link) => link.getAttribute('aria-label'))).toEqual([
      'Kilde: Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
      'Kilde: Tildelingsbrev Nkom 2022',
    ]);
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
const Host = ({ mode = 'excerpt' }: { mode?: 'excerpt' | 'document' }) => {
  const citations = useMemo(() => answerCitations(text, sources, markers, mode), [mode]);
  const [toSource, setToSource] = useState<SourceTarget>();
  const [toAnswer, setToAnswer] = useState<AnswerTarget>();
  const [followed, setFollowed] = useState<number>();
  return (
    <>
      <Answer
        text={text}
        sources={sources}
        markers={markers}
        citationMode={mode}
        target={toAnswer}
        onOpenCitation={(citation, target) => {
          setFollowed(citation);
          setToSource(target);
        }}
      />
      <Sources
        sources={sources}
        citations={citations}
        citationMode={mode}
        target={toSource}
        onShowUse={(citation) => setToAnswer({ citation })}
        onReturn={() => {
          if (followed !== undefined) setToAnswer({ citation: followed });
        }}
      />
    </>
  );
};

const excerptRow = (n: number) =>
  screen
    .getByText(`Utdrag ${n}`, { selector: '.uib-sources-excerpt-number' })
    .closest('.uib-sources-excerpt') as HTMLElement;

describe('the pairing, both ways, between the answer and Sources', () => {
  it('pairs every footnote with an excerpt shown under its number, and every numbered excerpt with a footnote', () => {
    render(<Host />);
    const inAnswer = new Set(
      footnotes().map((link) => /^Utdrag (\d+)/.exec(link.getAttribute('aria-label') ?? '')?.[1]),
    );
    const inSources = new Set(
      screen
        .getAllByText(/^Utdrag \d+$/, { selector: '.uib-sources-excerpt-number' })
        .map((label) => label.textContent?.slice('Utdrag '.length)),
    );
    expect([...inAnswer].sort()).toEqual(['1', '2', '3']);
    expect([...inSources].sort()).toEqual([...inAnswer].sort());
    // The excerpt nothing cites is shown without a number, and says so.
    const uncited = screen
      .getByText('Ledelsen vurderer måloppnåelsen som god.')
      .closest('.uib-sources-excerpt') as HTMLElement;
    expect(uncited.dataset.uncited).toBe('true');
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

  it('leads from an excerpt back to each footnote that cites it, in turn', async () => {
    render(<Host />);
    const back = within(excerptRow(1)).getByRole('button', {
      name: 'Vis hvor svaret bruker utdrag 1 (1/2)',
    });
    fireEvent.click(back);
    await frame();
    expect(document.activeElement).toBe(footnotes()[0]);
    fireEvent.click(back);
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

  it('pairs by document both ways in document mode', async () => {
    render(<Host mode="document" />);
    fireEvent.click(footnotes()[1] as HTMLElement);
    await frame();
    expect(document.activeElement?.textContent).toBe(nkom.title);
    const back = screen.getByRole('button', {
      name: `Vis hvor svaret bruker ${nkom.title} (1/2)`,
    });
    fireEvent.click(back);
    await frame();
    expect(document.activeElement).toBe(footnotes()[1]);
    const memoCard = screen
      .getByRole('heading', { name: memo.title })
      .closest('.uib-sources-document') as HTMLElement;
    expect(within(memoCard).getByText('Ikke vist til i svaret')).toBeTruthy();
  });
});

describe('«Kilder brukt i svaret»', () => {
  const rows = () =>
    within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((row) => row.textContent);

  it('lists each document the answer cites, in the order Sources shows them, with its excerpts’ numbers', () => {
    draw();
    expect(screen.getByText('Kilder brukt i svaret').closest('details')?.open).toBe(true);
    expect(rows()).toEqual([
      'Årsrapport Nasjonal kommunikasjonsmyndighet 2021Utdrag 2–3',
      'Tildelingsbrev Nkom 2022Utdrag 1',
    ]);
  });

  it('writes numbers that are not a run as a list', () => {
    render(
      <Answer
        text="A [3]. B [1]. C [2]."
        sources={sources}
        markers={[...markers.slice(0, 2), { marker: '3', chunkId: 'kudos::2021-3' }]}
      />,
    );
    expect(rows()).toEqual([
      'Årsrapport Nasjonal kommunikasjonsmyndighet 2021Utdrag 1, 3',
      'Tildelingsbrev Nkom 2022Utdrag 2',
    ]);
  });

  it('names the documents and numbers none of them in document mode', () => {
    draw({ citationMode: 'document' });
    expect(rows()).toEqual([nkom.title, tildeling.title]);
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
    expect(link.querySelector('.ds-sr-only')?.textContent).toBe(', ditt dokument');
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

describe('the catalogue', () => {
  it('speaks English when the reader does', () => {
    render(
      <InLocale locale="en">
        <Answer text={text} sources={sources} markers={markers} />
      </InLocale>,
    );
    expect(
      screen.getAllByRole('link', { name: /^Excerpt 1: Tildelingsbrev/ }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Sources used in the answer')).toBeTruthy();
    expect(screen.getByText('Excerpts 2–3')).toBeTruthy();
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });
});
