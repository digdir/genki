// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../sources/fixtures/signatures.js';
import { Sources } from '../sources/Sources.js';
import type { SourceDocument } from '../sources/types.js';
import { Answer } from './Answer.js';
import { readFootnotes } from './citations.js';
import fixture from './fixtures/genki-test-answers.json' with { type: 'json' };

document.getAnimations ??= () => [];
afterEach(cleanup);

type Wire = Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

// The contract's wire shape to the block's props, as an app does it.
const sourceOf = (raw: Wire): SourceDocument => ({
  index: typeof raw.index === 'number' ? raw.index : undefined,
  title: str(raw.title) ?? '',
  url: str(raw.url),
  documentId: str(raw.document_id),
  excerpts: ((raw.excerpts as Wire[] | undefined) ?? []).map((e) => ({
    chunkId: str(e.chunk_id) ?? '',
    text: str(e.text) ?? '',
    position: typeof e.position === 'number' ? e.position : undefined,
  })),
});

interface Captured {
  file: string;
  text: string;
  noAnswer: boolean;
  sources: SourceDocument[];
}

const ofWire = (file: string, raw: Wire): Captured => ({
  file,
  text: str(raw.answer) ?? '',
  noAnswer: raw.no_answer === true,
  sources: ((raw.sources as Wire[] | undefined) ?? []).map(sourceOf),
});

const kept = fixture.answers.map((raw) => ofWire(`fixture/${raw.id}`, raw as Wire));

// More captured answers, one JSON file each, when a corpus folder is named.
const corpora = (process.env.GENAI_QA_CORPUS?.split(delimiter) ?? []).filter(existsSync);
const captured = corpora.flatMap((folder) =>
  readdirSync(folder)
    .filter((file) => /^q\d+.*\.json$/i.test(file))
    .map((file) =>
      ofWire(
        `${basename(folder)}/${file}`,
        JSON.parse(readFileSync(join(folder, file), 'utf8')) as Wire,
      ),
    ),
);
const answers = [...kept, ...captured];

const BLOCKS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'PRE',
  'TABLE',
  'TR',
  'H2',
  'H3',
  'H4',
  'H5',
]);
const HIDDEN = '.uib-answer-copy, .uib-markdown-cite-space, .ds-sr-only, [aria-hidden="true"]';

// What a reader sees: text that is drawn, with a line break between blocks.
const visible = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.matches(HIDDEN)) return '';
  if (node.nodeName === 'BR') return '\n';
  const inner = [...node.childNodes].map(visible).join(node.nodeName === 'TR' ? '\t' : '');
  return BLOCKS.has(node.nodeName) ? `\n${inner}\n` : inner;
};

describe('the answer on real answers from genki-test', () => {
  it('has the sample it claims', () => {
    expect(fixture.answers.length).toBeGreaterThanOrEqual(30);
    expect(fixture.genki).toMatch(/^[0-9a-f]{40}$/);
  });

  it('finds the source of every [N] genki-test wrote, by the contract’s rule', () => {
    const unresolved = (list: readonly Captured[]) =>
      list.flatMap(({ file, text, sources }) => {
        const read = readFootnotes(text, sources);
        return read.marks.size === read.written
          ? []
          : [`${file}: ${read.written - read.marks.size} of ${read.written} lead to no source`];
      });
    // An older capture may hold the service's own misses; the block draws those as text.
    if (captured.length) console.info(`Named corpora: ${JSON.stringify(unresolved(captured))}`);
    expect(unresolved(kept)).toEqual([]);
  });

  it('leads every footnote it draws to one document shown, and gives every document it lists a footnote', () => {
    let written = 0;
    let drawn = 0;
    let merged = 0;
    let listed = 0;
    const problems: string[] = [];
    for (const { file, text, noAnswer, sources } of answers) {
      const read = readFootnotes(text, sources);
      written += read.written;
      merged += [...read.marks.values()].filter((m) => m.kind === 'dropped').length;
      if (read.pairing.unpaired.length) problems.push(`${file}: unpaired ${read.pairing.unpaired}`);

      render(
        <Answer text={text} sources={sources} noAnswer={noAnswer} onOpenDocument={() => {}} />,
      );
      const labels = screen
        .queryAllByRole('link', { name: /^Kilde: / })
        .map((link) => link.getAttribute('aria-label')?.slice('Kilde: '.length) ?? '');
      drawn += labels.length;
      if (labels.length !== read.citations.length)
        problems.push(`${file}: ${labels.length} drawn, ${read.citations.length} footnotes`);
      const summary = screen.queryByText('Kilder brukt i svaret')?.closest('details');
      const rows = summary
        ? within(summary as HTMLElement)
            .getAllByRole('link')
            .map((link) => link.textContent ?? '')
        : [];
      listed += rows.length;
      // Both ways: each footnote names a document in the list, and each listed document has one.
      for (const label of new Set(labels))
        if (!rows.includes(label)) problems.push(`${file}: footnote to «${label}» not listed`);
      for (const row of rows)
        if (!labels.includes(row)) problems.push(`${file}: «${row}» listed without a footnote`);
      cleanup();
    }
    console.info(
      `${answers.length} answers: ${written} [N] written, ${drawn} footnotes drawn, ${merged} merged with the one before, ${listed} documents listed`,
    );
    expect(written).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });

  it('gives Sources the same footnotes, so each document the answer cites links back to its uses', () => {
    let backLinks = 0;
    for (const { file, text, sources } of answers.filter((a) => a.sources.length)) {
      const { citations, pairing } = readFootnotes(text, sources);
      render(
        <Sources sources={sources} citations={citations} onShowUse={() => {}} search={false} />,
      );
      const buttons = screen.queryAllByRole('button', { name: /^Vis hvor svaret bruker / });
      backLinks += buttons.length;
      expect(buttons.length, file).toBe(pairing.uses.size);
      cleanup();
    }
    expect(backLinks).toBeGreaterThan(0);
  });

  it('draws no leftover from the source format in what a reader sees', () => {
    const counts: Record<string, number> = {};
    const leftovers: string[] = [];
    // Only answers whose every [N] has a source: one that has none stays text, by the rule above.
    const whole = answers.filter(({ text, sources }) => {
      const read = readFootnotes(text, sources);
      return read.marks.size === read.written;
    });
    for (const { file, text, noAnswer, sources } of whole) {
      const { container } = render(<Answer text={text} sources={sources} noAnswer={noAnswer} />);
      for (const [name, found] of Object.entries(scan(visible(container)))) {
        counts[name] = (counts[name] ?? 0) + found.length;
        for (const hit of found) leftovers.push(`${file} ${name} «${hit.match}»: ${hit.context}`);
      }
      cleanup();
    }
    console.info(`Scanned ${whole.length} answers; hits per signature ${JSON.stringify(counts)}`);
    expect(whole.length).toBeGreaterThanOrEqual(kept.length);
    expect(leftovers).toEqual([]);
  });
});
