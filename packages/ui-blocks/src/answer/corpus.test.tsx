// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scan } from '../sources/fixtures/signatures.js';
import { documentKeys } from '../sources/pairing.js';
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
const HIDDEN = '.uib-footnote-copy, .uib-markdown-cite-space, .ds-sr-only, [aria-hidden="true"]';

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

  // genki-test's answers cite documents: `[N]` is the source with `index: N`, and a cited document
  // often carries several excerpts, so no footnote says which excerpt it means.
  it('draws no footnote on answers that cite only documents, and lists every document they cite', () => {
    let written = 0;
    let cited = 0;
    let listed = 0;
    const problems: string[] = [];
    for (const { file, text, noAnswer, sources } of answers) {
      const read = readFootnotes(text, sources);
      written += read.written;
      if (read.pairing.mode !== 'document' && read.citations.length)
        problems.push(`${file}: footnotes read as excerpts`);
      if (read.pairing.unpaired.length) problems.push(`${file}: unpaired ${read.pairing.unpaired}`);
      const keys = documentKeys(sources);
      const used = sources.filter((_, i) => read.pairing.uses.has(keys[i] ?? ''));
      cited += used.length;

      const { container } = render(
        <Answer
          text={text}
          sources={sources}
          noAnswer={noAnswer}
          onOpenDocument={() => {}}
          onOpenExcerpt={() => {}}
        />,
      );
      const marks = container.querySelectorAll('.uib-footnote-mark');
      if (marks.length) problems.push(`${file}: ${marks.length} footnotes drawn`);
      if (/\b(?:Kilde|Utdrag) \d/.test(visible(container)))
        problems.push(`${file}: a number is shown`);
      const summary = screen.queryByText('Kilder brukt i svaret')?.closest('details');
      const rows = summary
        ? within(summary as HTMLElement)
            .getAllByRole('link')
            .map((link) => link.textContent ?? '')
        : [];
      listed += rows.length;
      if (!noAnswer && rows.length !== used.length)
        problems.push(`${file}: ${rows.length} listed, ${used.length} cited`);
      cleanup();
    }
    console.info(
      `${answers.length} answers: ${written} [N] written, ${cited} documents cited, ${listed} listed, 0 footnotes drawn`,
    );
    expect(written).toBeGreaterThan(100);
    expect(listed).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it('gives Sources the same footnotes, which number nothing and link nothing back', () => {
    let documents = 0;
    for (const { file, text, sources } of answers.filter((a) => a.sources.length)) {
      const { citations, pairing } = readFootnotes(text, sources);
      const keys = documentKeys(sources);
      const { container } = render(
        <Sources sources={sources} citations={citations} onShowUse={() => {}} search={false} />,
      );
      const cards = [...container.querySelectorAll<HTMLElement>('.uib-sources-document')];
      expect(cards.length, file).toBe(sources.length);
      expect(container.textContent, file).not.toMatch(/\b(?:Kilde|Utdrag) \d/);
      expect(within(container).queryAllByRole('link', { name: /^Fotnote \d/ }), file).toEqual([]);
      cards.forEach((card, i) => {
        // A document no footnote names says so; a cited one does not.
        expect(
          within(card).queryByText('Ikke vist til i svaret') === null,
          `${file} document ${i + 1}`,
        ).toBe(pairing.uses.has(keys[i] ?? ''));
      });
      documents += cards.length;
      cleanup();
    }
    expect(documents).toBeGreaterThan(0);
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
