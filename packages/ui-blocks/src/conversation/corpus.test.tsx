// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFootnotes } from '../answer/citations.js';
import fixture from '../answer/fixtures/genki-test-answers.json' with { type: 'json' };
import { scan } from '../sources/fixtures/signatures.js';
import type { SourceDocument } from '../sources/types.js';
import { Conversation } from './Conversation.js';
import { answerVisibleText } from './search.js';
import type { ConversationAnswer, ConversationTurn } from './types.js';

document.getAnimations ??= () => [];
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

type Wire = Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

// The contract's wire shape to the block's turns, as an app does it.
const sourceOf = (raw: Wire): SourceDocument => ({
  index: typeof raw.index === 'number' ? raw.index : undefined,
  title: str(raw.title) ?? '',
  url: str(raw.url),
  documentId: str(raw.document_id),
  excerpts: ((raw.excerpts as Wire[] | undefined) ?? []).map((e) => ({
    chunkId: str(e.chunk_id) ?? '',
    text: str(e.text) ?? '',
  })),
});

// The answers genki-test gave on 6 November, each after the question that asked it.
const exchanges = fixture.answers.map((raw) => {
  const wire = raw as Wire;
  const id = str(wire.id) ?? '';
  const answer: ConversationAnswer = {
    kind: 'answer',
    id: `${id}-answer`,
    text: str(wire.answer) ?? '',
    status: 'complete',
    noAnswer: wire.no_answer === true,
    sources: ((wire.sources as Wire[] | undefined) ?? []).map(sourceOf),
  };
  return { id, question: str(wire.question) ?? '', answer };
});
const turns: ConversationTurn[] = exchanges.flatMap(({ id, question, answer }) => [
  { kind: 'question', id: `${id}-question`, text: question },
  answer,
]);

const BLOCKS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'TABLE', 'TR', 'H2', 'H3', 'H4']);
const HIDDEN = '.uib-answer-copy, .uib-markdown-cite-space, .ds-sr-only, [aria-hidden="true"]';

// What a reader sees, as the answer's own corpus test reads it: text that is drawn, a line
// between blocks, and a tab between the cells of a table row.
const visible = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.matches(HIDDEN)) return '';
  if (node.nodeName === 'BR') return '\n';
  const inner = [...node.childNodes].map(visible).join(node.nodeName === 'TR' ? '\t' : '');
  return BLOCKS.has(node.nodeName) ? `\n${inner}\n` : inner;
};

const fold = (text: string) => text.toLocaleLowerCase('nb');

// Words to search for in an answer: every fifth word of five letters or more, up to four.
const queries = (text: string) =>
  [...new Set(text.match(/[\p{L}\p{N}]{5,}/gu) ?? [])].filter((_, i) => i % 5 === 0).slice(0, 4);

const occurrences = (text: string, query: string) => fold(text).split(fold(query)).length - 1;

describe('the conversation on real answers from genki-test', () => {
  it('has the sample it claims: every captured answer with the question that asked it', () => {
    expect(exchanges.length).toBeGreaterThanOrEqual(30);
    expect(exchanges.every(({ question, answer }) => question && answer.text)).toBe(true);
  });

  it('draws every question and every answer as one conversation, in order', () => {
    render(<Conversation turns={turns} />);
    const items = [...(screen.getAllByRole('list')[0]?.children ?? [])];
    expect(items.map((item) => item.getAttribute('data-kind'))).toEqual(
      turns.map((turn) => turn.kind),
    );
    for (const [i, { question }] of exchanges.entries())
      expect(items[2 * i]?.textContent).toBe(`Du skrev:${question}`);
  });

  // genki-test's answers cite documents, and footnotes are numbered by excerpt only.
  it('draws no footnote in answers that cite only documents, as the answer block does', () => {
    const { container } = render(<Conversation turns={turns} />);
    let cited = 0;
    for (const { answer } of exchanges) {
      const read = readFootnotes(answer.text, answer.sources);
      expect(read.pairing.numbers.size, answer.id).toBe(0);
      cited += read.citations.length;
    }
    expect(container.querySelectorAll('.uib-answer-mark')).toHaveLength(0);
    console.info(`${exchanges.length} exchanges, ${cited} footnotes naming documents, 0 drawn`);
    expect(cited).toBeGreaterThan(100);
  });

  it('lands every search mark on the words searched for, and counts what is there', () => {
    let searched = 0;
    let marked = 0;
    const problems: string[] = [];
    for (const { answer } of exchanges) {
      const visible = answerVisibleText(answer).text;
      render(<Conversation turns={[answer]} search />);
      fireEvent.click(screen.getByRole('button', { name: 'Søk i svaret' }));
      for (const query of queries(visible)) {
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
        const expected = occurrences(visible, query);
        const marks = [...document.querySelectorAll('mark.uib-conversation-mark')];
        // A match across two pieces of text, such as the end of a bold word, is two marks.
        const text = marks.map((mark) => mark.textContent ?? '').join('');
        if (fold(text) !== fold(query).repeat(expected))
          problems.push(`${answer.id} «${query}»: marked «${text}», ${expected} expected`);
        const status = document.querySelector('.uib-conversation-search-count')?.textContent;
        if (status !== `1 av ${expected} treff`)
          problems.push(`${answer.id} «${query}»: said «${status}», ${expected} expected`);
        searched += 1;
        marked += expected;
      }
      cleanup();
    }
    console.info(`${searched} searches in ${exchanges.length} answers, ${marked} matches marked`);
    expect(searched).toBeGreaterThanOrEqual(100);
    expect(problems).toEqual([]);
  });

  it('draws no leftover from the source format in the questions or the answers', () => {
    const { container } = render(<Conversation turns={turns} />);
    const found = Object.entries(scan(visible(container))).flatMap(([name, hits]) =>
      hits.map((hit) => `${name} «${hit.match}»: ${hit.context}`),
    );
    console.info(`Scanned ${turns.length} turns: ${found.length} leftovers`);
    expect(found).toEqual([]);
  });
});
