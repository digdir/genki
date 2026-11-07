import type { Locale } from '@genai/i18n';
import { translator } from '../i18n.js';
import { documentKeys } from '../sources/pairing.js';
import { distinctNames } from '../sources/Sources.js';
import type { SourceDocument } from '../sources/types.js';
import { readFootnotes, type AnswerMarker } from './citations.js';

export interface AnswerCopyOptions {
  /** The contract's `sources[]`. */
  sources?: readonly SourceDocument[] | undefined;
  /** The contract's top-level `markers`, when the service cites excerpts. */
  markers?: readonly AnswerMarker[] | undefined;
  /** The language of the reference list's words, «s.» or «p.». */
  locale?: Locale | undefined;
}

export interface AnswerCopy {
  /** The answer as text, its footnotes numbered as drawn, and the reference list under it. */
  text: string;
  /** How many references went along, for `AnswerActions`' receipt. */
  sources: number;
}

// A footnote and the space before it: the space goes with it, or «kvartalsvis [1].» is pasted as
// «kvartalsvis .».
const footnote = /([ \t]?)\[(\d{1,3})\]/g;
const blockSyntax = /^(#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s?)/;

/** What a `[N]` becomes: a new number, nothing (it leads nowhere), or itself (it is prose). */
type Label = number | null | undefined;

/** Markdown stripped to what a reader pastes into a document. Tables go tab separated. */
const plain = (markdown: string, label: (n: number) => Label) =>
  markdown
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !/^\|[\s:|-]+\|$/.test(line))
    .map((line) =>
      line.startsWith('|')
        ? line
            .replace(/^\||\|$/g, '')
            .split('|')
            .map((cell) => cell.trim())
            .join('\t')
        : line.replace(blockSyntax, ''),
    )
    .join('\n')
    .replace(footnote, (whole, space: string, n: string) => {
      const shown = label(Number(n));
      return shown === undefined ? whole : shown === null ? '' : `${space}[${shown}]`;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const yearOf = (date: string | undefined) => {
  const year = date ? new Date(date).getUTCFullYear() : Number.NaN;
  return Number.isNaN(year) ? undefined : year;
};

/**
 * What «Kopier svaret» puts on the clipboard, as kunnskapsassistenten copies it: the answer with
 * its footnotes, and a reference list under it, since an answer must not leave the app without
 * where it came from. One line per numbered excerpt, since two excerpts from one report are on
 * different pages. An answer whose footnotes name only documents is drawn without footnotes, so it
 * is copied without them, with one unnumbered line per cited document. Each part is left out when
 * the source lacks it. With no sources, the clean text alone.
 */
/**
 * How much of an answer on its way is finished, as plain text without footnotes, for a live
 * region: everything up to the last blank line, since the tail is still being written. Empty
 * before the first block is done. kunnskapsassistenten's `announcedText`.
 */
export const finishedText = (markdown: string) => {
  const lastBreak = markdown.lastIndexOf('\n\n');
  return lastBreak < 0 ? '' : plain(markdown.slice(0, lastBreak), () => null);
};

export const answerCopy = (text: string, options: AnswerCopyOptions = {}): AnswerCopy => {
  const { sources = [], markers, locale = 'nb' } = options;
  const t = translator(locale);
  const { pairing } = readFootnotes(text, sources, markers);
  const byExcerpt = pairing.mode === 'excerpt';
  const keys = documentKeys(sources);
  const names = distinctNames(sources, (title, id) => t('sources.sameTitle', { title, id })).map(
    (name) => name || t('sources.untitled'),
  );
  const byMarker = new Map(markers?.map((m) => [m.marker, m] as const));

  const where = (title: string, page: number | undefined) =>
    page === undefined ? title : t('answer.copyPage', { title, page });
  const line = (
    n: number | undefined,
    title: string,
    page: number | undefined,
    at: SourceDocument,
  ) => {
    const year = yearOf(at.publishedAt);
    const url = at.url;
    return [
      n === undefined ? undefined : `[${n}]`,
      `${where(title, page)}${year === undefined ? '' : ` (${year})`}.`,
      url,
    ]
      .filter(Boolean)
      .join(' ');
  };

  const references = byExcerpt
    ? sources
        .flatMap((source, i) =>
          source.excerpts.flatMap((excerpt) => {
            const n = pairing.numbers.get(excerpt.chunkId);
            return n === undefined
              ? []
              : [{ n, text: line(n, names[i] ?? '', excerpt.page, source) }];
          }),
        )
        .toSorted((a, b) => a.n - b.n)
        .map((r) => r.text)
    : sources.flatMap((source, i) =>
        pairing.uses.has(keys[i] ?? '') ? [line(undefined, names[i] ?? '', undefined, source)] : [],
      );

  // Where a written `[N]` leads, by the contract's rule: the marker it names, or the source with
  // `index: N`. One that names nothing is prose, such as a list number, and stays.
  const label = (n: number): Label => {
    // With nothing to list, a footnote alone points at a panel the clipboard cannot carry.
    if (references.length === 0) return null;
    const marker = markers ? byMarker.get(String(n)) : undefined;
    const at = markers
      ? marker
        ? sources.findIndex(
            (s) =>
              s.excerpts.some((e) => e.chunkId === marker.chunkId) ||
              (marker.documentId !== undefined && s.documentId === marker.documentId),
          )
        : -1
      : sources.findIndex((s) => s.index === n);
    if ((markers && !marker) || (!markers && at < 0)) return undefined;
    // One that names only a document is drawn as nothing, so it is copied as nothing.
    return (byExcerpt && marker && pairing.numbers.get(marker.chunkId)) || null;
  };

  const body = plain(text, label);
  return references.length === 0
    ? { text: body, sources: 0 }
    : {
        text: [body, '', t('answer.copyHeading'), ...references].join('\n'),
        sources: references.length,
      };
};
