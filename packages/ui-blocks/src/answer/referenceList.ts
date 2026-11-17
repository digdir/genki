import type { Locale } from '@genai/i18n';
import { documentKeys, type Pairing } from '../sources/pairing.js';
import type { SourceDocument } from '../sources/types.js';
import { documentNumbers } from './citations.js';
import { translator } from './i18n.js';

/** One document in the Kildeliste: the footnotes that cite it, and what its reference says. */
export interface Reference {
  key: string;
  /** Every footnote in the answer that leads to it, as drawn: «2, 5, 6». */
  footnotes: readonly number[];
  /** What kind of document it is, «Årsrapport». */
  documentType?: string | undefined;
  title: string;
  /** The year it was published, from `publishedAt`. */
  year?: number | undefined;
  /** The organisation that published it. */
  publisher?: string | undefined;
  /** The pages of its cited excerpts, in order, each once. */
  pages: readonly number[];
  /** Its address, only when it is a web address: a link from untrusted data goes nowhere else. */
  url?: string | undefined;
}

export interface ReferenceOptions {
  /** As the answer's `documentFootnotes`: footnotes that name documents keep their numbers. */
  documentFootnotes?: boolean | undefined;
  /** As the answer's `numberEachFootnote`: each footnote keeps its own number, as drawn. */
  numberEachFootnote?: boolean | undefined;
}

const yearOf = (date: string | undefined) => {
  const year = date ? new Date(date).getUTCFullYear() : Number.NaN;
  return Number.isNaN(year) ? undefined : year;
};

const webAddress = /^https?:\/\/\S+$/i;

/**
 * The Kildeliste under an answer (dev-kildeliste): each document the answer cites once, with
 * every footnote that leads to it, sorted by its first footnote. The numbers are the ones the
 * answer draws, by the same options, so «2, 5, 6» in the list are the marks in the text.
 */
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
    // A document cited as a whole has no pages of its own in the answer.
    const pages = byExcerpt
      ? [...new Set(cited.flatMap((e) => (e.page === undefined ? [] : [e.page])))].toSorted(
          (a, b) => a - b,
        )
      : [];
    const url = source.url?.trim();
    return [
      {
        key,
        footnotes,
        documentType: source.documentType?.trim() || undefined,
        title: source.title.trim(),
        year: yearOf(source.publishedAt),
        publisher: source.publisher?.trim() || undefined,
        pages,
        url: url && webAddress.test(url) ? url : undefined,
      },
    ];
  });
  // Sorting is stable: documents without a number keep the order of `sources`, last.
  return rows.toSorted((a, b) => (a.footnotes[0] ?? Infinity) - (b.footnotes[0] ?? Infinity) || 0);
};

/** Pages in runs, «12–13, 27», with an en dash between the ends of a run. */
export const pageRanges = (pages: readonly number[]) => {
  const runs: [number, number][] = [];
  for (const page of pages) {
    const last = runs.at(-1);
    if (last && page === last[1] + 1) last[1] = page;
    else runs.push([page, page]);
  }
  return runs.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`)).join(', ');
};

/**
 * A reference in its parts, in the order it is read: «Årsrapport, 2022, *Årsrapport 2021*.
 * Nasjonal kommunikasjonsmyndighet. Side 12–13, 27. URL». A part the source lacks is left out.
 */
export const referenceParts = (reference: Reference, locale: Locale) => {
  const t = translator(locale);
  return {
    /** Before the title, each followed by a comma: the document type and the year. */
    lead: [reference.documentType, reference.year?.toString()].filter(
      (part): part is string => !!part,
    ),
    title: reference.title || t('sources.untitled'),
    publisher: reference.publisher,
    pages: reference.pages.length
      ? t('answer.referencePages', {
          count: reference.pages.length,
          pages: pageRanges(reference.pages),
        })
      : undefined,
  };
};

// Markdown's own characters in a text, so it is its words and never a link or emphasis.
const escaped = (text: string) => text.replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`);

/**
 * What «Kopier kildeliste» puts on the clipboard (rd-kildeliste-md): one bullet per document, in
 * the list's order, its footnotes in brackets, then the reference as the list shows it, the title
 * in italics and the address in angle brackets so it is a link:
 * `- [2, 5, 6] Årsrapport, 2022, *Årsrapport 2021*. Nkom. Side 12–13, 27. <URL>`.
 * No heading, so the reader can put the list under their own.
 */
export const referencesMarkdown = (list: readonly Reference[], locale: Locale) =>
  list
    .map((reference) => {
      const { lead, title, publisher, pages } = referenceParts(reference, locale);
      return [
        reference.footnotes.length ? `- [${reference.footnotes.join(', ')}]` : '-',
        `${lead.map((part) => `${escaped(part)}, `).join('')}*${escaped(title)}*.`,
        publisher ? `${escaped(publisher)}.` : undefined,
        pages ? `${pages}.` : undefined,
        reference.url ? `<${reference.url}>` : undefined,
      ]
        .filter(Boolean)
        .join(' ');
    })
    .join('\n');
