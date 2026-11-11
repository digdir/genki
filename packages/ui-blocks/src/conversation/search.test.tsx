// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SourceDocument } from '../sources/types.js';
import { Conversation } from './Conversation.js';
import { answerVisibleText } from './search.js';
import type { ConversationAnswer, ConversationQuestion, ConversationTurn } from './types.js';

document.getAnimations ??= () => [];
const scrolled: Element[] = [];
beforeAll(() => {
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  cleanup();
  scrolled.length = 0;
});

const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

const source: SourceDocument = {
  index: 1,
  title: 'Årsrapport Nkom 2021',
  documentId: 'kudos::2021',
  excerpts: [{ chunkId: 'kudos::2021-1', text: 'Måloppnåelsen er god.' }],
};

const ask = (id: string, text: string): ConversationQuestion => ({ kind: 'question', id, text });
const reply = (id: string, text: string, rest: Partial<ConversationAnswer> = {}) =>
  ({ kind: 'answer', id, text, status: 'complete', sources: [source], ...rest }) as const;

const first = reply(
  'a1',
  [
    '### Måloppnåelse',
    '',
    'Nkom rapporterer **måloppnåelse** hvert år [1]. Måloppnåelsen var god i 2021 [1].',
    '',
    '- Målene i tildelingsbrevet',
    '- Måloppnåelse per mål',
  ].join('\n'),
);
const second = reply('a2', 'Den andre rapporten nevner måloppnåelse én gang [1].');
const two: ConversationTurn[] = [
  ask('q1', 'Hva er måloppnåelse?'),
  first,
  ask('q2', 'Og så?'),
  second,
];

const toggles = () => screen.getAllByRole('button', { name: 'Søk i svaret' });
const toggle = (i: number) => toggles()[i] as HTMLElement;
const field = () => screen.getByRole('searchbox');
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const count = () => document.querySelector('.uib-conversation-search-count')?.textContent;
const marks = () => [...document.querySelectorAll('mark.uib-conversation-mark')];
const current = () => [...document.querySelectorAll('mark[data-current]')];

describe('search in the answers', () => {
  it('is offered only when the host asks for it', () => {
    render(<Conversation turns={two} />);
    expect(screen.queryByRole('button', { name: 'Søk i svaret' })).toBeNull();
  });

  it('is offered under each finished answer, and not under one still being written', () => {
    render(
      <Conversation
        turns={[...two, ask('q3', 'Mer?'), reply('a3', 'Skriver', { status: 'streaming' })]}
        search
      />,
    );
    expect(toggles()).toHaveLength(2);
    expect(toggles().every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(
      true,
    );
  });

  it('hands the app’s row its button, so it stands among the app’s actions', () => {
    render(
      <Conversation
        turns={two}
        search
        actions={(_turn, parts) => (
          <div className="app-row">
            <button type="button">Kopier svaret</button>
            {parts.search}
          </div>
        )}
      />,
    );
    expect(toggles()[0]?.closest('.app-row')).not.toBeNull();
  });

  it('opens a strip first in the block, with the field focused and named by the answer it searches', () => {
    const { container } = render(<Conversation turns={two} search />);
    fireEvent.click(toggle(1));
    const strip = container.querySelector('search');
    expect(strip?.parentElement?.firstElementChild).toBe(strip);
    expect(document.activeElement).toBe(field());
    expect(screen.getByRole('searchbox', { name: 'Søk i svar 2 av 2' })).toBeTruthy();
    expect(toggles()[1]?.getAttribute('aria-expanded')).toBe('true');
  });

  it('says only «Søk i svaret» when there is one answer', () => {
    render(<Conversation turns={[ask('q1', 'Hva?'), first]} search />);
    fireEvent.click(toggle(0));
    expect(screen.getByRole('searchbox', { name: 'Søk i svaret' })).toBeTruthy();
  });

  it('counts answers, not questions back, when it says which answer', () => {
    render(
      <Conversation
        turns={[
          ask('q1', 'Hva?'),
          { kind: 'clarification', id: 'c1', text: 'Hvilket år?' },
          ask('q2', '2021'),
          first,
        ]}
        search
      />,
    );
    fireEvent.click(toggle(0));
    expect(screen.getByRole('searchbox', { name: 'Søk i svaret' })).toBeTruthy();
  });

  it('searches one answer at a time, and starts afresh in another', () => {
    render(<Conversation turns={two} search />);
    fireEvent.click(toggle(0));
    type('måloppnåelse');
    expect(marks().length).toBeGreaterThan(0);
    fireEvent.click(toggle(1));
    expect(screen.getAllByRole('searchbox')).toHaveLength(1);
    expect((field() as HTMLInputElement).value).toBe('');
    expect(toggles()[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(marks()).toHaveLength(0);
  });

  it('marks every match in the answer it searches, and none in the others', () => {
    render(<Conversation turns={two} search />);
    fireEvent.click(toggle(0));
    type('måloppnåelse');
    // The heading, the bold word, «Måloppnåelsen» and the list item: four, whatever the case.
    expect(marks().map((mark) => mark.textContent?.toLocaleLowerCase('nb'))).toEqual([
      'måloppnåelse',
      'måloppnåelse',
      'måloppnåelse',
      'måloppnåelse',
    ]);
    expect(marks().every((mark) => mark.closest('li[data-kind="answer"]')?.contains(mark))).toBe(
      true,
    );
    const answers = document.querySelectorAll('li[data-kind="answer"]');
    expect(answers[1]?.querySelector('mark')).toBeNull();
    expect(count()).toBe('1 av 4 treff');
  });

  it('never searches a footnote’s number, which is no word in the answer', () => {
    render(<Conversation turns={two} search />);
    fireEvent.click(toggle(0));
    type('[1]');
    expect(count()).toBe('Ingen treff');
    expect(marks()).toHaveLength(0);
  });

  it('says why it does nothing before two characters, and when nothing matches', () => {
    render(<Conversation turns={two} search />);
    fireEvent.click(toggle(0));
    expect(count()).toBe('');
    type('m');
    expect(count()).toBe('Skriv minst 2 tegn');
    expect(marks()).toHaveLength(0);
    type('xyz');
    expect(count()).toBe('Ingen treff');
    expect(screen.queryByRole('button', { name: 'Neste treff i svaret' })).toBeNull();
  });

  it('steps through the matches and stops at the ends, scrolling to the one it stands on', async () => {
    render(<Conversation turns={two} search />);
    fireEvent.click(toggle(0));
    type('måloppnåelse');
    await frame();
    expect(scrolled.at(-1)).toBe(current()[0]);
    const previous = screen.getByRole('button', { name: 'Forrige treff i svaret' });
    const next = screen.getByRole('button', { name: 'Neste treff i svaret' });
    expect(previous.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(previous);
    expect(count()).toBe('1 av 4 treff');
    for (let i = 0; i < 5; i += 1) fireEvent.click(next);
    expect(count()).toBe('4 av 4 treff');
    expect(next.getAttribute('aria-disabled')).toBe('true');
    expect(current()).toHaveLength(1);
    expect(current()[0]).toBe(marks()[3]);
    await frame();
    expect(scrolled.at(-1)).toBe(marks()[3]);
  });

  it('closes on Escape, takes its marks with it, and gives focus back to the button', () => {
    render(<Conversation turns={two} search />);
    fireEvent.click(toggle(0));
    type('måloppnåelse');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Neste treff i svaret' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(marks()).toHaveLength(0);
    expect(document.activeElement).toBe(toggles()[0]);
    expect(toggles()[0]?.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes from its own button and from the button that opened it', () => {
    render(<Conversation turns={two} search />);
    fireEvent.click(toggle(0));
    fireEvent.click(screen.getByRole('button', { name: 'Lukk søk i svaret' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(toggle(0));
    fireEvent.click(toggle(0));
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('empties with the field’s own clear button', () => {
    render(<Conversation turns={two} search />);
    fireEvent.click(toggle(0));
    type('måloppnåelse');
    const strip = document.querySelector('search') as HTMLElement;
    fireEvent.click(within(strip).getByRole('button', { name: 'Tøm søket' }));
    expect(marks()).toHaveLength(0);
    expect(count()).toBe('');
  });

  it('closes by itself when the answer it searched leaves the thread', () => {
    const { rerender } = render(<Conversation turns={two} search />);
    fireEvent.click(toggle(1));
    rerender(<Conversation turns={two.slice(0, 2)} search />);
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('raises no event of its own for the app to handle', () => {
    const onOpenCitation = vi.fn();
    render(<Conversation turns={two} search onOpenCitation={onOpenCitation} />);
    fireEvent.click(toggle(0));
    type('måloppnåelse');
    fireEvent.click(screen.getByRole('button', { name: 'Neste treff i svaret' }));
    expect(onOpenCitation).not.toHaveBeenCalled();
  });
});

describe('the words an answer is searched in', () => {
  it('are the words it is drawn with: no Markdown syntax and no footnote numbers', () => {
    const { text } = answerVisibleText(first);
    expect(text).not.toMatch(/[[\]*#]/);
    expect(text.split('\n')[0]).toBe('Måloppnåelse');
    expect(text).toContain('Nkom rapporterer måloppnåelse hvert år');
  });

  it('keep a [N] that is no footnote, such as one whose source never came', () => {
    expect(answerVisibleText(reply('x', 'Se [2].', { sources: [source] })).text).toBe('Se [2].');
    expect(answerVisibleText(reply('x', 'Se [1].', { sources: undefined })).text).toBe('Se [1].');
  });

  it('leave out the [N] a stopped answer marks as lost', () => {
    const stopped = reply('x', 'Se [1].', { status: 'aborted', sources: undefined });
    expect(answerVisibleText(stopped).text).not.toContain('[1]');
  });
});
