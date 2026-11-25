import type { Locale } from '@genai/i18n';
import { documentKeys, type Pairing } from '../sources/pairing.js';
import type { SourceDocument } from '../sources/types.js';
import { documentNumbers } from './citations.js';
import { translator } from './i18n.js';

export interface Reference {
  key: string;
  footnotes: readonly number[];
  title: string;
  year?: number | undefined;
  publisher?: string | undefined;
  pages: readonly PageRun[];
  url?: string | undefined;
}

export interface ReferenceOptions {
  documentFootnotes?: boolean | undefined;
  numberEachFootnote?: boolean | undefined;
}

const yearOf = (date: string | undefined) => {
  const year = date ? new Date(date).getUTCFullYear() : Number.NaN;
  return Number.isNaN(year) ? undefined : year;
};

// No `<` or `>`, which would end the copied `<…>` link early.
const webAddress = /^https?:\/\/[^\s<>]+$/i;

const oneLine = (text: string | undefined) => text?.replace(/\s+/g, ' ').trim() || undefined;

export type PageRun = readonly [number, number];

/** Runs of pages, sorted and joined where they touch or overlap. */
const joinRuns = (runs: readonly PageRun[]): PageRun[] => {
  const joined: [number, number][] = [];
  for (const [from, to] of runs.toSorted((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = joined.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else joined.push([from, to]);
  }
  return joined;
};

export const references = (
  sources: readonly SourceDocument[],
  pairing: Pairing,
  { documentFootnotes = false, numberEachFootnote = false }: ReferenceOptions = {},
): Reference[] => {
  const keys = documentKeys(sources);
  const byExcerpt = pairing.mode === 'excerpt';
  const byDocument = documentFootnotes ? documentNumbers(pairing) : new Map<string, number>();
  const rows = sources.flatMap((source, i): Reference[] => {
    const key = keys[i] ?? `@${i}`;
    const cited = byExcerpt
      ? source.excerpts.filter((e) => pairing.numbers.has(e.chunkId))
      : pairing.uses.has(key)
        ? source.excerpts
        : [];
    if (byExcerpt ? cited.length === 0 : !pairing.uses.has(key)) return [];
    const numbers = byExcerpt
      ? cited.flatMap((e) =>
          numberEachFootnote
            ? (pairing.uses.get(e.chunkId) ?? []).map((at) => at + 1)
            : [pairing.numbers.get(e.chunkId) ?? 0],
        )
      : [byDocument.get(key)].filter((n): n is number => n !== undefined);
    const footnotes = [...new Set(numbers)].toSorted((a, b) => a - b);
    const pages = byExcerpt
      ? joinRuns(
          cited.flatMap((e): PageRun[] =>
            e.page === undefined ? [] : [[e.page, Math.max(e.page, e.pageEnd ?? e.page)]],
          ),
        )
      : [];
    const url = source.url?.trim();
    return [
      {
        key,
        footnotes,
        title: oneLine(source.title) ?? '',
        year: yearOf(source.publishedAt),
        publisher: oneLine(source.publisher),
        pages,
        url: url && webAddress.test(url) ? url : undefined,
      },
    ];
  });
  return rows.toSorted((a, b) => (a.footnotes[0] ?? Infinity) - (b.footnotes[0] ?? Infinity) || 0);
};

export const pageRanges = (runs: readonly PageRun[]) =>
  runs.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(', ');

const ended = (text: string) => /[.?!]/.test(text.at(-1) ?? '');

/** APA 7 (dev-kildeliste): publisher, (year), title, pages; no publisher puts the title first. */
export const referenceParts = (reference: Reference, locale: Locale) => {
  const t = translator(locale);
  const title = reference.title || t('sources.untitled');
  return {
    author:
      reference.publisher &&
      (ended(reference.publisher) ? reference.publisher : `${reference.publisher}.`),
    year: reference.year === undefined ? undefined : `(${reference.year}).`,
    title,
    titleEnd: ended(title) ? '' : '.',
    pages: reference.pages.length
      ? t('answer.referencePages', {
          count: reference.pages.reduce((n, [from, to]) => n + (to > from ? 2 : 1), 0),
          pages: pageRanges(reference.pages),
        })
      : undefined,
  };
};

const escaped = (text: string) => text.replace(/[\\`*_[\]<>#|~&]/g, (c) => `\\${c}`);

export const referencesMarkdown = (list: readonly Reference[], locale: Locale) =>
  list
    .map((reference) => {
      const { author, year, title, titleEnd, pages } = referenceParts(reference, locale);
      const named = `*${escaped(title)}*${titleEnd}`;
      return [
        reference.footnotes.length ? `- [${reference.footnotes.join(', ')}]` : '-',
        ...(author ? [escaped(author), year, named] : [named, year]),
        pages ? `${pages}.` : undefined,
        reference.url ? `<${reference.url}>` : undefined,
      ]
        .filter(Boolean)
        .join(' ');
    })
    .join('\n');
