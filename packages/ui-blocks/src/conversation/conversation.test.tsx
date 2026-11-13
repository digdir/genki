// @vitest-environment jsdom
import { catalogueProblems } from '@genai/i18n';
import { InLocale } from '@genai/i18n/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { nb as sharedNb } from '../i18n.js';
import type { SourceDocument } from '../sources/types.js';
import { Conversation, type ConversationProps } from './Conversation.js';
import { en, nb } from './i18n.js';
import type {
  ConversationAnswer,
  ConversationClarification,
  ConversationQuestion,
  ConversationTurn,
} from './types.js';

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
  excerpts: [
    { chunkId: 'kudos::2021-1', text: 'Nkoms totale utgiftsbevilgning var 594,2 mill. kroner.' },
  ],
};
const tildeling: SourceDocument = {
  index: 2,
  title: 'Tildelingsbrev Nkom 2022',
  documentId: 'kudos::2022',
  excerpts: [{ chunkId: 'kudos::2022-1', text: 'Nkom skal rapportere kvartalsvis.' }],
};

// 14.00 in Oslo on a Tuesday, so «i går» and the weekday are not the same day.
const now = new Date('2026-09-15T12:00:00Z');

const question: ConversationQuestion = {
  kind: 'question',
  id: 'q1',
  text: 'Hva rapporterer Nkom om?',
};
const answer: ConversationAnswer = {
  kind: 'answer',
  id: 'a1',
  text: 'Nkom rapporterer kvartalsvis [2], og bevilgningen var 594,2 mill. kroner [1].',
  status: 'complete',
  sources: [nkom, tildeling],
  // Footnotes are numbered by excerpt only, so the markers name theirs.
  markers: [
    { marker: '1', chunkId: 'kudos::2021-1', documentId: 'kudos::2021' },
    { marker: '2', chunkId: 'kudos::2022-1', documentId: 'kudos::2022' },
  ],
  createdAt: '2026-09-15T12:32:00Z',
};
const followUp: ConversationQuestion = { kind: 'question', id: 'q2', text: 'Og i 2022?' };
const clarification: ConversationClarification = {
  kind: 'clarification',
  id: 'c1',
  text: 'Mener du tildelingsbrevet eller årsrapporten [1]?',
};
const turns: ConversationTurn[] = [question, answer, followUp, clarification];

const draw = (props: Partial<ConversationProps> = {}) =>
  render(<Conversation turns={turns} now={now} {...props} />);

// The conversation's own items: the first list on the page, and not the lists inside an answer.
const items = () => [...(screen.getAllByRole('list')[0]?.children ?? [])];

describe('the thread’s title', () => {
  it('stands over the conversation as a heading, «lg» at level 2, as kunnskapsassistenten’s', () => {
    draw({ title: 'Rapportering i Nkom' });
    const heading = screen.getByRole('heading', { level: 2, name: 'Rapportering i Nkom' });
    expect(heading.getAttribute('data-size')).toBe('lg');
    expect(heading.classList.contains('ds-sr-only')).toBe(false);
    expect(
      heading.compareDocumentPosition(screen.getByText(question.text)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('is in the outline but out of sight when it only repeats the question', () => {
    draw({ title: 'Hva rapporterer Nkom om' });
    const heading = screen.getByRole('heading', { level: 2, name: 'Hva rapporterer Nkom om' });
    expect(heading.classList.contains('ds-sr-only')).toBe(true);
    cleanup();
    draw({ title: 'Nkom', titleRepeatsQuestion: true });
    expect(screen.getByRole('heading', { name: 'Nkom' }).classList.contains('ds-sr-only')).toBe(
      true,
    );
  });

  it('reads the question’s first sentence in linear time, however long its run of stops', () => {
    const stops = '!'.repeat(100_000);
    for (const text of [`${stops}x`, `Hva${stops}`, `Hva ${'.?'.repeat(50_000)}x y`]) {
      cleanup();
      const started = performance.now();
      draw({ turns: [{ kind: 'question', id: 'q', text }], title: 'Hva' });
      expect(performance.now() - started).toBeLessThan(1000);
    }
    cleanup();
    draw({
      turns: [{ ...question, text: 'Hva rapporterer Nkom om?!… Og mer.' }],
      title: 'Hva rapporterer Nkom om',
    });
    expect(screen.getByRole('heading', { level: 2 }).classList.contains('ds-sr-only')).toBe(true);
  });

  it('is not drawn when the app gives none', () => {
    draw();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });
});

describe('the conversation', () => {
  it('is one ordered list, a turn per item, in the order they were said', () => {
    const { container } = draw();
    expect(container.querySelector('ol.uib-conversation-turns')).not.toBeNull();
    expect(items().map((item) => item.getAttribute('data-kind'))).toEqual([
      'question',
      'answer',
      'question',
      'clarification',
    ]);
  });

  it('draws nothing but its live region when there is nothing to draw', () => {
    const { container } = render(<Conversation turns={[]} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('');
  });

  it('speaks English when the reader does', () => {
    render(
      <InLocale locale="en">
        <Conversation turns={turns} now={now} />
      </InLocale>,
    );
    expect(screen.getAllByText('You wrote:')).toHaveLength(2);
    expect(screen.getByText('Needs clarification')).toBeTruthy();
    expect(screen.getByText(/^The answer came 15 September 2026/)).toBeTruthy();
  });

  it('has an English text for every Norwegian one', () => {
    expect(catalogueProblems(nb, en)).toEqual([]);
  });

  it('keeps its words to itself, out of the shared catalogue that Approach loads', () => {
    expect(Object.keys(nb)).toEqual(['conversation', 'answer']);
    expect(sharedNb).not.toHaveProperty('conversation');
  });
});

describe('the reader’s question', () => {
  it('stands in a tinted box of its own, at the end of the line, in the colour the host passes', () => {
    draw({ questionColor: 'accent' });
    const box = screen.getByText(question.text).closest('.uib-conversation-question');
    expect(box?.classList.contains('ds-card')).toBe(true);
    expect(box?.getAttribute('data-variant')).toBe('tinted');
    expect(box?.getAttribute('data-color')).toBe('accent');
    expect(box?.closest('li')?.getAttribute('data-kind')).toBe('question');
  });

  it('follows the host’s colour family when the host passes none', () => {
    draw();
    const box = screen.getByText(question.text).closest('.uib-conversation-question');
    expect(box?.hasAttribute('data-color')).toBe(false);
  });

  it('is said to be the reader’s, in words', () => {
    draw();
    const [first] = items();
    expect(first?.querySelector('.ds-sr-only')?.textContent).toBe('Du skrev:');
  });

  it('is written in the size of the answer, not larger, and is the only thing in such a box', () => {
    const { container } = draw();
    expect(screen.getByText(question.text).getAttribute('data-size')).toBeNull();
    expect(container.querySelectorAll('.uib-conversation-question')).toHaveLength(2);
    expect(screen.getByText(/Nkom rapporterer/).closest('.uib-conversation-question')).toBeNull();
  });

  it('names the documents it was asked with under the words, and keeps its own language', () => {
    render(
      <Conversation
        turns={[{ ...question, attachments: ['notat.pdf', 'brev.docx'], lang: 'en' }]}
      />,
    );
    const words = screen.getByText(question.text);
    const files = screen.getByText('Med vedlegg: notat.pdf, brev.docx');
    expect(words.compareDocumentPosition(files)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(words.getAttribute('lang')).toBe('en');
  });
});

describe('each answer', () => {
  it('is the Answer block, with its footnotes and «Kilder brukt i svaret»', () => {
    draw({ answerColor: 'neutral' });
    const card = screen.getByText(/Nkom rapporterer/).closest('.uib-answer');
    expect(card?.getAttribute('data-color')).toBe('neutral');
    // Marks, not links: this app gives the footnotes nowhere to go.
    expect(screen.getAllByRole('img', { name: /^Utdrag \d+: / })).toHaveLength(2);
    expect(screen.getByText('Kilder brukt i svaret')).toBeTruthy();
  });

  it('draws no footnote for an answer whose markers name only documents', () => {
    draw({ turns: [question, { ...answer, markers: undefined }] });
    expect(screen.queryAllByRole('img', { name: /^(?:Utdrag|Kilde) \d+: / })).toEqual([]);
    expect(screen.getByText('Kilder brukt i svaret')).toBeTruthy();
    expect(screen.getByText(/Nkom rapporterer/).textContent).not.toMatch(/\[\d\]/);
  });

  it('tells the app which answer a footnote, a document or an excerpt was followed in', () => {
    const onOpenCitation = vi.fn();
    const onOpenDocument = vi.fn();
    const onOpenExcerpt = vi.fn();
    draw({ onOpenCitation, onOpenDocument, onOpenExcerpt });
    fireEvent.click(
      screen.getAllByRole('link', { name: /^Utdrag 1: Tildelingsbrev/ })[0] as Element,
    );
    expect(onOpenCitation).toHaveBeenCalledWith(answer, 0, {
      chunkId: 'kudos::2022-1',
      documentId: 'kudos::2022',
      index: 2,
    });
    fireEvent.click(screen.getByText('Kilder brukt i svaret'));
    fireEvent.click(screen.getByRole('link', { name: 'Tildelingsbrev Nkom 2022' }));
    expect(onOpenDocument).toHaveBeenCalledWith(answer, tildeling);
    fireEvent.click(screen.getByRole('link', { name: 'Utdrag 1 i Kilder' }));
    expect(onOpenExcerpt).toHaveBeenCalledWith(answer, {
      chunkId: 'kudos::2022-1',
      documentId: 'kudos::2022',
      index: 2,
    });
  });

  it('gives each footnote the id the app makes from its answer and its place', () => {
    draw({
      citationId: (turn, citation) => `${turn.id}-fn-${citation}`,
      onOpenCitation: () => {},
    });
    expect(
      screen.getAllByRole('link', { name: /^Utdrag \d+: / }).map((link) => link.getAttribute('id')),
    ).toEqual(['a1-fn-0', 'a1-fn-1']);
  });

  it('moves focus to the footnote the app points at, in that answer only', async () => {
    const second: ConversationAnswer = { ...answer, id: 'a2' };
    const both = [question, answer, followUp, second];
    const { rerender } = render(<Conversation turns={both} onOpenCitation={() => {}} />);
    rerender(
      <Conversation
        turns={both}
        onOpenCitation={() => {}}
        target={{ turnId: 'a2', citation: 1 }}
      />,
    );
    await frame();
    const focused = document.activeElement;
    expect(focused?.getAttribute('aria-label')).toBe(
      'Utdrag 2: Årsrapport Nasjonal kommunikasjonsmyndighet 2021',
    );
    expect(focused?.closest('li')).toBe(items()[3]);
  });

  it('moves focus back to a title in «Kilder brukt i svaret» the app points at', async () => {
    const { rerender } = render(<Conversation turns={turns} onOpenDocument={() => {}} />);
    rerender(
      <Conversation
        turns={turns}
        onOpenDocument={() => {}}
        target={{ turnId: 'a1', document: { documentId: 'kudos::2022' } }}
      />,
    );
    await frame();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: tildeling.title }));
  });

  it('offers to ask a stopped question again, and says which', () => {
    const onRegenerate = vi.fn();
    const stopped: ConversationAnswer = { ...answer, status: 'aborted', sources: undefined };
    render(<Conversation turns={[question, stopped]} onRegenerate={onRegenerate} now={now} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generer på nytt' }));
    expect(onRegenerate).toHaveBeenCalledWith(stopped, question);
  });

  it('puts focus on the new answer when «Generer på nytt» goes away with the turn it was under', () => {
    const stopped: ConversationAnswer = { ...answer, status: 'aborted', sources: undefined };
    const Shell = () => {
      const [shown, setShown] = useState<ConversationAnswer>(stopped);
      return (
        <Conversation
          turns={[question, shown]}
          // As an app that replaces the turn in place, with a new id.
          onRegenerate={() => setShown({ ...answer, id: 'a1-again', status: 'streaming' })}
        />
      );
    };
    render(<Shell />);
    const button = screen.getByRole('button', { name: 'Generer på nytt' });
    button.focus();
    fireEvent.click(button);
    expect(screen.queryByRole('button', { name: 'Generer på nytt' })).toBeNull();
    expect(document.activeElement).toBe(items()[1]);
    expect((document.activeElement as HTMLElement).dataset.kind).toBe('answer');
  });

  it('moves no focus when an answer finishes: a control the app owns keeps it', async () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    const streaming: ConversationAnswer = { ...answer, status: 'streaming' };
    const { rerender } = render(<Conversation turns={[question, streaming]} />);
    rerender(<Conversation turns={[question, answer]} />);
    await frame();
    expect(document.activeElement).toBe(field);
    field.remove();
  });

  it('leaves focus where the reader moved it before the new answer came', () => {
    const stopped: ConversationAnswer = { ...answer, status: 'aborted', sources: undefined };
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    let replace = () => {};
    const Shell = () => {
      const [shown, setShown] = useState<ConversationAnswer>(stopped);
      replace = () => setShown({ ...answer, id: 'a1-again', status: 'streaming' });
      return <Conversation turns={[question, shown]} onRegenerate={() => {}} />;
    };
    render(<Shell />);
    const button = screen.getByRole('button', { name: 'Generer på nytt' });
    button.focus();
    fireEvent.click(button);
    elsewhere.focus();
    act(() => replace());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('says under a question nothing answered that it got no answer, and offers to ask it again', () => {
    const onRegenerate = vi.fn();
    render(<Conversation turns={[question, followUp]} onRegenerate={onRegenerate} />);
    const standIns = document.querySelectorAll('[data-unanswered="true"]');
    expect(standIns).toHaveLength(2);
    expect(standIns[0]?.previousElementSibling?.textContent).toContain(question.text);
    expect(standIns[0]?.textContent).toContain(
      'Dette spørsmålet fikk ikke noe svar. Noe gikk galt underveis.',
    );
    fireEvent.click(
      within(standIns[1] as HTMLElement).getByRole('button', { name: 'Generer på nytt' }),
    );
    expect(onRegenerate.mock.calls[0]?.[1]).toBe(followUp);
    expect(onRegenerate.mock.calls[0]?.[0]).toMatchObject({ kind: 'answer', status: 'failed' });
  });

  it('draws no such note while an answer is on its way, or while the thread is read', () => {
    render(<Conversation turns={[question]} pending />);
    expect(document.querySelector('[data-unanswered]')).toBeNull();
    cleanup();
    render(<Conversation turns={[question]} loading />);
    expect(document.querySelector('[data-unanswered]')).toBeNull();
    cleanup();
    // A question back is a turn that answers.
    render(<Conversation turns={[question, clarification]} />);
    expect(document.querySelector('[data-unanswered]')).toBeNull();
  });

  it('says over the card what the question was narrowed to, and to a screen reader that it is the answer’s', () => {
    render(<Conversation turns={[question, { ...answer, scope: 'Avgrenset til: Årsrapport' }]} />);
    const line = document.querySelector('.uib-conversation-scope');
    expect(line?.textContent).toBe('Svaret er Avgrenset til: Årsrapport');
    const card = screen.getByText(/Nkom rapporterer/).closest('.uib-answer');
    expect(line?.compareDocumentPosition(card as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('draws no scope line for a question asked of everything', () => {
    draw();
    expect(document.querySelector('.uib-conversation-scope')).toBeNull();
  });

  it('words the scope from the filter and the corpus, as two facts, as kunnskapsassistenten does', () => {
    const line = (scope: ConversationAnswer['scope']) => {
      cleanup();
      render(<Conversation turns={[question, { ...answer, scope }]} />);
      return document.querySelector('.uib-conversation-scope')?.textContent ?? null;
    };
    expect(line({ narrowedTo: ['Årsrapport', '2023'] })).toBe(
      'Svaret er Avgrenset til: Årsrapport · 2023',
    );
    expect(line({ narrowedTo: ['Årsrapport'], corpus: 'Kudos' })).toBe(
      'Svaret er Avgrenset til: Årsrapport, fra Kudos',
    );
    expect(line({ corpus: 'Kudos' })).toBe('Svaret er Hentet fra Kudos');
    expect(line({ narrowedTo: [] })).toBeNull();
  });

  it('passes on why an answer failed, so the card says it', () => {
    render(
      <Conversation
        turns={[question, { ...answer, text: '', status: 'failed', failure: { kind: 'timeout' } }]}
      />,
    );
    expect(screen.getByText('Svaret tok for lang tid')).toBeTruthy();
  });
});

describe('what a screen reader hears of an answer on its way', () => {
  const region = () => document.querySelector('[aria-live="polite"]')?.textContent;
  const coming: ConversationAnswer = { ...answer, id: 'a2', text: '', status: 'streaming' };

  it('says it is coming, each block once it is finished, and that it is done', () => {
    const { rerender } = render(<Conversation turns={[question, coming]} />);
    expect(region()).toBe('Henter svar.');
    rerender(<Conversation turns={[question, { ...coming, text: 'Nkom rapporterer [1]' }]} />);
    expect(region()).toBe('Henter svar.');
    const first = { ...coming, text: 'Nkom rapporterer [1].\n\nBevilg' };
    rerender(<Conversation turns={[question, first]} />);
    expect(region()).toBe('Nkom rapporterer.');
    rerender(<Conversation turns={[question, { ...first, status: 'complete' }]} />);
    expect(region()).toBe('Svaret er ferdig.');
  });

  it('reads a finished block as its words, with no bold, italics, code marks or link addresses', () => {
    const { rerender } = render(<Conversation turns={[question, coming]} />);
    const text =
      'Årsrapporten sier at **Altinn 3 utgjorde 14 prosent** av trafikken, se _[rapporten](https://kudos.dfo.no/dokument/2024)_ og `skjema` [1].\n\nNeste';
    rerender(<Conversation turns={[question, { ...coming, text }]} />);
    expect(region()).toBe(
      'Årsrapporten sier at Altinn 3 utgjorde 14 prosent av trafikken, se rapporten og skjema.',
    );
  });

  it('says a stopped answer stopped, one that found nothing, and the warning on one with no sources', () => {
    const ended = (turn: ConversationAnswer) => {
      cleanup();
      const { rerender } = render(<Conversation turns={[question, coming]} />);
      rerender(<Conversation turns={[question, turn]} />);
      return region();
    };
    expect(ended({ ...coming, status: 'aborted' })).toBe('Genereringen ble avbrutt.');
    expect(ended({ ...coming, status: 'complete', text: 'Ingen treff.', noAnswer: true })).toBe(
      'Fant ingen utdrag om dette i dokumentene.',
    );
    expect(ended({ ...coming, status: 'complete', text: 'Svar.', sources: [] })).toBe(
      'Svaret er ferdig. Svaret har ingen kilder. Kontroller det mot originaldokumentene før du bruker det.',
    );
  });

  it('says that the assistant asks back, and nothing of a thread read back', () => {
    const { rerender } = render(<Conversation turns={[question]} pending />);
    rerender(
      <Conversation turns={[question, clarification]} assistantName="Kunnskapsassistenten" />,
    );
    expect(region()).toBe('Kunnskapsassistenten trenger en avklaring.');
    cleanup();
    const { rerender: again } = render(<Conversation turns={[]} loading />);
    again(<Conversation turns={turns} />);
    expect(region()).toBe('');
  });
});

describe('an answer that takes long', () => {
  const streaming: ConversationAnswer = { ...answer, id: 'a2', text: '', status: 'streaming' };
  const region = () => document.querySelector('[aria-live="polite"]')?.textContent;
  const line = () => document.querySelector('.uib-conversation-slow');

  it('says after 30 seconds without progress that it takes longer than usual, as a line and once to a screen reader', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Conversation turns={[question, streaming]} />);
      act(() => vi.advanceTimersByTime(29_999));
      expect(line()).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(line()?.textContent).toBe('Dette tar lengre tid enn vanlig.');
      expect(region()).toBe('Dette tar lengre tid enn vanlig.');
      // A word arrives: the line goes, and the region keeps its words.
      const word = { ...streaming, text: 'Nkom' };
      rerender(<Conversation turns={[question, word]} />);
      expect(line()).toBeNull();
      expect(region()).toBe('Dette tar lengre tid enn vanlig.');
      // A second wait shows the line again, and is not said again.
      act(() => vi.advanceTimersByTime(30_000));
      expect(line()).not.toBeNull();
      expect(region()).toBe('Dette tar lengre tid enn vanlig.');
      rerender(<Conversation turns={[question, { ...word, status: 'complete' }]} />);
      expect(region()).toBe('Svaret er ferdig.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the app after five minutes without progress, so it can stop the answer', () => {
    vi.useFakeTimers();
    try {
      const onStalled = vi.fn();
      const { rerender } = render(
        <Conversation turns={[question, streaming]} onStalled={onStalled} />,
      );
      act(() => vi.advanceTimersByTime(299_000));
      rerender(
        <Conversation turns={[question, { ...streaming, text: 'N' }]} onStalled={onStalled} />,
      );
      act(() => vi.advanceTimersByTime(299_000));
      expect(onStalled).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1_000));
      expect(onStalled.mock.calls.map(([turn]) => turn.id)).toEqual(['a2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws no line when the host turns it off', () => {
    vi.useFakeTimers();
    try {
      render(<Conversation turns={[question, streaming]} slowAfter={false} />);
      act(() => vi.advanceTimersByTime(60_000));
      expect(line()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('following an answer on its way', () => {
  // jsdom lays nothing out, so the column's sizes and the observer are the test's.
  let resized: (() => void) | undefined;
  beforeAll(() => {
    globalThis.ResizeObserver ??= class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  });

  const column = () => {
    const element = document.createElement('div');
    const box = { top: 500, height: 1000 };
    Object.defineProperties(element, {
      scrollTop: { get: () => box.top, set: (value: number) => (box.top = value) },
      scrollHeight: { get: () => box.height },
      clientHeight: { get: () => 500 },
    });
    document.body.append(element);
    return { element, box };
  };

  it('keeps the column at its end while the reader is there, and lets go when they scroll up', () => {
    const { element, box } = column();
    const onAtEndChange = vi.fn();
    const streaming: ConversationAnswer = { ...answer, id: 'a2', status: 'streaming' };
    render(
      <Conversation
        turns={[question, streaming]}
        scrollContainer={{ current: element }}
        onAtEndChange={onAtEndChange}
      />,
    );
    box.height = 1400;
    act(() => resized?.());
    expect(box.top).toBe(1400);
    // The browser reports the block's own jump as a scroll.
    act(() => {
      element.dispatchEvent(new Event('scroll'));
    });
    box.top = 600;
    act(() => {
      element.dispatchEvent(new Event('scroll'));
    });
    expect(onAtEndChange).toHaveBeenLastCalledWith(false);
    box.height = 1800;
    act(() => resized?.());
    expect(box.top).toBe(600);
    element.remove();
  });

  it('follows the question that starts the thread, though it already reaches below the edge', () => {
    // As at 390 px: the block mounts with the first question and the answer's outline, already
    // 300 px taller than the column.
    const { element, box } = column();
    box.top = 0;
    box.height = 800;
    const streaming: ConversationAnswer = { ...answer, id: 'a2', status: 'streaming' };
    render(<Conversation turns={[question, streaming]} scrollContainer={{ current: element }} />);
    expect(box.top).toBe(800);
    box.height = 1400;
    act(() => resized?.());
    expect(box.top).toBe(1400);
    element.remove();
  });

  it('leaves a thread that opens with no answer on its way where it is', () => {
    const { element, box } = column();
    box.top = 0;
    box.height = 800;
    render(<Conversation turns={turns} scrollContainer={{ current: element }} />);
    box.height = 1400;
    act(() => resized?.());
    expect(box.top).toBe(0);
    element.remove();
  });

  it('counts the last 80 pixels as the end', () => {
    const { element, box } = column();
    const onAtEndChange = vi.fn();
    render(
      <Conversation
        turns={turns}
        scrollContainer={{ current: element }}
        onAtEndChange={onAtEndChange}
      />,
    );
    box.top = 420;
    act(() => {
      element.dispatchEvent(new Event('scroll'));
    });
    expect(onAtEndChange).toHaveBeenLastCalledWith(true);
    box.top = 419;
    act(() => {
      element.dispatchEvent(new Event('scroll'));
    });
    expect(onAtEndChange).toHaveBeenLastCalledWith(false);
    element.remove();
  });

  it('leaves the column alone when the host turns following off', () => {
    const { element, box } = column();
    const streaming: ConversationAnswer = { ...answer, id: 'a2', status: 'streaming' };
    render(
      <Conversation
        turns={[question, streaming]}
        follow={false}
        scrollContainer={{ current: element }}
      />,
    );
    box.height = 1400;
    act(() => resized?.());
    expect(box.top).toBe(500);
    element.remove();
  });
});

describe('the slots', () => {
  it('put the app’s header over an answer and a question back, with the question it answers', () => {
    const header = vi.fn((turn: ConversationAnswer | ConversationClarification) => (
      <p>Fremgangsmåte for {turn.id}</p>
    ));
    draw({ header });
    expect(header.mock.calls.map(([turn, asked]) => [turn.id, asked?.id])).toEqual([
      ['a1', 'q1'],
      ['c1', 'q2'],
    ]);
    const over = screen.getByText('Fremgangsmåte for a1');
    const card = screen.getByText(/Nkom rapporterer/).closest('.uib-answer');
    expect(over.compareDocumentPosition(card as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('find the question back over the turn a question back stands between', () => {
    const header = vi.fn(() => null);
    const after: ConversationAnswer = { ...answer, id: 'a2' };
    render(<Conversation turns={[question, clarification, after]} header={header} />);
    expect(header.mock.calls.map(([turn, asked]) => [turn.id, asked?.id])).toEqual([
      ['c1', 'q1'],
      ['a2', 'q1'],
    ]);
  });

  it('hand the app’s row the time for its far end, under a finished answer only', () => {
    const actions = vi.fn((_turn: ConversationAnswer, parts: { end: unknown }) => (
      <div className="app-row">
        <button type="button">Kopier svaret</button>
        <span className="app-end">{parts.end as never}</span>
      </div>
    ));
    const streaming: ConversationAnswer = { ...answer, id: 'a2', status: 'streaming' };
    render(
      <Conversation turns={[question, answer, followUp, streaming]} actions={actions} now={now} />,
    );
    // Which answers get a row, whatever the number of renders.
    expect([...new Set(actions.mock.calls.map(([turn]) => turn.id))]).toEqual(['a1']);
    const time = screen.getByText('14:32').closest('time');
    expect(time?.closest('.app-end')).not.toBeNull();
    expect(time?.getAttribute('dateTime')).toBe('2026-09-15T12:32:00.000Z');
  });

  it('draw the time alone at the end of the row when the app has no row of its own', () => {
    draw();
    const time = screen.getByText('14:32').closest('time');
    expect(time?.parentElement?.classList.contains('uib-answer-row-slot')).toBe(true);
  });
});

describe('the time an answer came', () => {
  it('stands outside every button, so no button’s name changes with the clock', () => {
    const { container } = draw({
      actions: (_turn, parts) => (
        <>
          <button type="button">Kopier svaret</button>
          {parts.end}
        </>
      ),
    });
    const times = container.querySelectorAll('time');
    expect(times).toHaveLength(1);
    expect(times[0]?.closest('button, a')).toBeNull();
    for (const button of screen.getAllByRole('button'))
      expect(button.textContent).not.toMatch(/14/);
  });

  it('is said in full to a screen reader, since the short text leaves out the year', () => {
    render(
      <Conversation
        turns={[question, { ...answer, createdAt: '2025-05-12T07:05:00Z' }]}
        now={now}
      />,
    );
    const time = screen.getByText('12. mai').closest('time');
    expect(time?.querySelector('[aria-hidden="true"]')?.textContent).toBe('12. mai');
    expect(time?.querySelector('.ds-sr-only')?.textContent).toBe(
      'Svaret kom 12. mai 2025 kl. 09:05',
    );
    expect(time?.getAttribute('title')).toBe('12. mai 2025 kl. 09:05');
  });

  it('stands under a stopped answer too, beside «Generer på nytt»', () => {
    const stopped: ConversationAnswer = { ...answer, status: 'aborted', sources: undefined };
    render(<Conversation turns={[question, stopped]} onRegenerate={() => {}} now={now} />);
    const row = screen.getByRole('button', { name: 'Generer på nytt' }).parentElement;
    expect(row?.querySelector('time')).not.toBeNull();
  });

  it('is not drawn on an answer still being written, on a question back, or on a question', () => {
    const { container } = render(
      <Conversation
        turns={[
          { ...question, id: 'q0' },
          { ...answer, id: 'a0', status: 'streaming', text: '', sources: undefined },
          question,
          { ...answer, status: 'streaming', sources: undefined },
          followUp,
          { ...clarification, id: 'c9' },
        ]}
        now={now}
      />,
    );
    expect(container.querySelectorAll('time')).toHaveLength(0);
  });

  it('is left out when the answer has no time, or one that cannot be read', () => {
    const { container } = render(
      <Conversation
        turns={[
          question,
          { ...answer, createdAt: undefined },
          followUp,
          { ...answer, id: 'a2', createdAt: 'ikke en dato' },
        ]}
      />,
    );
    expect(container.querySelectorAll('time')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/Invalid/);
  });
});

describe('the question back', () => {
  it('is marked as a question with an info tag, in words', () => {
    draw();
    const tag = screen.getByText('Trenger avklaring');
    expect(tag.classList.contains('ds-tag')).toBe(true);
    expect(tag.getAttribute('data-color')).toBe('info');
  });

  it('is said to be the assistant’s question, by name when the host gives one', () => {
    draw();
    expect(screen.getByText('KI-assistenten spurte:')).toBeTruthy();
    cleanup();
    draw({ assistantName: 'Kunnskapsassistenten' });
    expect(screen.getByText('Kunnskapsassistenten spurte:')).toBeTruthy();
  });

  it('leaves a bracketed number as text, because nothing was retrieved for it', () => {
    render(<Conversation turns={[question, clarification]} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/årsrapporten \[1\]\?/)).toBeTruthy();
  });

  it('has no row: no button, no time and no actions, since the one move is to answer', () => {
    const actions = vi.fn(() => <button type="button">Kopier</button>);
    const { container } = render(
      <Conversation turns={[question, clarification]} actions={actions} search now={now} />,
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('time')).toBeNull();
    expect(actions).not.toHaveBeenCalled();
  });

  it('offers the service’s answers as choices when the app takes the reply, and says which turn', () => {
    const onReply = vi.fn();
    const choosing = { ...clarification, options: ['Tildelingsbrevet', 'Årsrapporten'] };
    render(<Conversation turns={[question, choosing]} onReply={onReply} />);
    const group = screen.getByRole('group', { name: 'Velg et svar' });
    fireEvent.click(within(group).getByRole('button', { name: 'Årsrapporten' }));
    expect(onReply).toHaveBeenCalledWith(choosing, 'Årsrapporten');
  });

  it('draws no choices the app cannot take', () => {
    render(<Conversation turns={[question, { ...clarification, options: ['Ja', 'Nei'] }]} />);
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('says over the card what it was narrowed to, as documents and not as a fetched question', () => {
    render(<Conversation turns={[question, { ...clarification, scope: 'Hentet fra Kudos' }]} />);
    expect(document.querySelector('.uib-conversation-scope')?.textContent).toBe(
      'Spørsmålet bygger på dokumenter Hentet fra Kudos',
    );
  });
});

describe('while the thread is read', () => {
  it('stands in a question and an answer in outline, hidden from a screen reader', () => {
    const { container } = render(<Conversation turns={[]} loading answerColor="neutral" />);
    const outline = container.querySelector('.uib-conversation-loading');
    expect(outline?.getAttribute('aria-hidden')).toBe('true');
    expect(outline?.querySelectorAll('.uib-answer-skeleton-line')).toHaveLength(4);
    expect(outline?.querySelector('.ds-card')?.getAttribute('data-color')).toBe('neutral');
  });

  it('says so in words through a region that was already in the page, empty at first', async () => {
    const { container } = render(<Conversation turns={[]} loading />);
    const region = container.querySelector('[aria-live="polite"]');
    expect(region?.textContent).toBe('');
    await act(() => new Promise((done) => setTimeout(done)));
    expect(region?.textContent).toBe('Henter samtalen');
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('keeps what is already on screen, and draws no outline over the reader’s own words', () => {
    const { container } = render(<Conversation turns={[question]} loading />);
    expect(screen.getByText(question.text)).toBeTruthy();
    expect(container.querySelector('.uib-conversation-loading')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('');
  });

  it('stops saying it once the turns are there', async () => {
    const { container, rerender } = render(<Conversation turns={[]} loading />);
    await act(() => new Promise((done) => setTimeout(done)));
    rerender(<Conversation turns={turns} />);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe('');
    expect(container.querySelector('.uib-conversation-loading')).toBeNull();
  });
});

describe('the dev boards’ answer, `answerVariant="plain"` (dev-kilder-hoyre)', () => {
  it('puts the assistant’s name over the header and the answer, for the eye, and the answer has no card', () => {
    const header = () => <p>Fremgangsmåte</p>;
    draw({
      answerVariant: 'plain',
      assistantName: 'Kunnskapsassistenten',
      answerColor: 'neutral',
      header,
    });
    const label = document.querySelector('.uib-conversation-label');
    expect(label?.textContent).toBe('Kunnskapsassistenten');
    // In the answers' family, as the answer it names.
    expect(label?.getAttribute('data-color')).toBe('neutral');
    expect(label?.getAttribute('aria-hidden')).toBe('true');
    const over = screen.getAllByText('Fremgangsmåte')[0] as HTMLElement;
    expect(label?.compareDocumentPosition(over)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(document.querySelector('.uib-answer')?.hasAttribute('data-plain')).toBe(true);
  });

  it('draws no label by default', () => {
    draw({ assistantName: 'Kunnskapsassistenten' });
    expect(document.querySelector('.uib-conversation-label')).toBeNull();
  });

  it('leaves out the label over a plain answer with `answerLabel={false}`, still with no card', () => {
    draw({ answerVariant: 'plain', answerLabel: false, assistantName: 'Kunnskapsassistenten' });
    expect(document.querySelector('.uib-conversation-label')).toBeNull();
    expect(screen.queryByText('Kunnskapsassistenten')).toBeNull();
    expect(document.querySelector('.uib-answer')?.hasAttribute('data-plain')).toBe(true);
  });
});
