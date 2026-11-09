import type { SourceDocument, SourceExcerpt } from './types.js';

/**
 * What the answer's footnotes name, read from the data: `excerpt` when every footnote names its
 * excerpt, `document` when some name only a document.
 */
export type CitationMode = 'excerpt' | 'document';

/** One footnote in the answer, in the answer's order: what it cites. */
export interface SourceCitation {
  /** The excerpt it cites, when the service cites excerpts. */
  chunkId?: string | undefined;
  documentId?: string | undefined;
  /** The contract's `[N]`, the source with `index: N`. */
  index?: number | undefined;
}

export interface Pairing {
  /** What the footnotes name. Only excerpt mode numbers anything. */
  mode: CitationMode;
  /**
   * Each cited excerpt's number, 1, 2, 3 in the order of first citation. Footnotes are numbered
   * by excerpt and never by document, so this is empty in document mode: a footnote that names
   * only a document gets no number, and no excerpt number is guessed for it.
   */
  numbers: ReadonlyMap<string, number>;
  /** Per footnote, the key of the shown item it leads to: a chunk id, or a document key. */
  targets: readonly (string | undefined)[];
  /** Per shown item, the footnotes that use it, as indexes into the citations. */
  uses: ReadonlyMap<string, readonly number[]>;
  /** Footnotes that lead to nothing shown, as indexes into the citations. */
  unpaired: readonly number[];
}

/** A key per document, unique in the list. */
export const documentKeys = (sources: readonly SourceDocument[]): string[] => {
  const seen = new Set<string>();
  return sources.map((source, i) => {
    const key = source.documentId ?? (source.index === undefined ? `@${i}` : `#${source.index}`);
    const unique = seen.has(key) ? `${key}@${i}` : key;
    seen.add(unique);
    return unique;
  });
};

/** A document's excerpts in the document's own order, by position, when every one has one. */
export const orderedExcerpts = (source: SourceDocument): readonly SourceExcerpt[] =>
  source.excerpts.every((e) => e.position !== undefined)
    ? source.excerpts.toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
    : source.excerpts;

/** The order Sources shows the documents and their excerpts in. */
export interface ReadingOrder {
  /** The documents, as indexes into `sources`, from the top. */
  documents: readonly number[];
  /** Per document, by its index into `sources`, its excerpts from the top. */
  excerpts: readonly (readonly SourceExcerpt[])[];
}

const ascending = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

/**
 * The order to show the documents and their excerpts in, from the pairing alone. When excerpts
 * are numbered, the documents run by their lowest number and, inside each, the cited excerpts by
 * number, so the panel reads «Utdrag 1», 2, 3 from the top as the footnotes do. What nothing cites
 * comes last, unnumbered: documents in the service's order, and excerpts last in their card, in
 * the document's order. When nothing is numbered, the order is the service's and the document's,
 * unchanged.
 */
export const readingOrder = (
  sources: readonly SourceDocument[],
  pairing: Pairing | undefined,
): ReadingOrder => {
  const cited: ReadonlyMap<string, number> =
    pairing?.mode === 'excerpt' ? pairing.numbers : new Map();
  const rank = (excerpt: SourceExcerpt | undefined) =>
    (excerpt && cited.get(excerpt.chunkId)) ?? Infinity;
  // Sorting is stable, so what nothing cites keeps its order.
  const excerpts = sources.map((source) =>
    cited.size === 0
      ? orderedExcerpts(source)
      : orderedExcerpts(source).toSorted((a, b) => ascending(rank(a), rank(b))),
  );
  const documents = sources
    .map((_, i) => i)
    .toSorted((a, b) => ascending(rank(excerpts[a]?.[0]), rank(excerpts[b]?.[0])));
  return { documents, excerpts };
};

export const citesExcerpts = (citations: readonly SourceCitation[]) =>
  citations.every((citation) => citation.chunkId !== undefined);

const documentOf = (
  sources: readonly SourceDocument[],
  keys: readonly string[],
  citation: SourceCitation,
): string | undefined => {
  const at =
    citation.chunkId === undefined
      ? citation.documentId === undefined
        ? sources.findIndex((s) => citation.index !== undefined && s.index === citation.index)
        : sources.findIndex((s) => s.documentId === citation.documentId)
      : sources.findIndex((s) => s.excerpts.some((e) => e.chunkId === citation.chunkId));
  return at < 0 ? undefined : keys[at];
};

/**
 * Pairs the answer's footnotes with the items shown, from the data alone: every
 * footnote leads to one shown item, every numbered item has its uses, and a footnote that leads
 * nowhere is reported, never guessed. When the footnotes name only documents, each still leads to
 * its document, for what the answer used, but nothing is numbered.
 */
export const pairCitations = (
  sources: readonly SourceDocument[],
  citations: readonly SourceCitation[],
): Pairing => {
  const mode: CitationMode = citesExcerpts(citations) ? 'excerpt' : 'document';
  const keys = documentKeys(sources);
  const shownChunks = new Set(sources.flatMap((s) => s.excerpts.map((e) => e.chunkId)));
  const numbers = new Map<string, number>();
  const uses = new Map<string, number[]>();
  const unpaired: number[] = [];
  const targets = citations.map((citation, i) => {
    const key =
      mode === 'excerpt'
        ? citation.chunkId !== undefined && shownChunks.has(citation.chunkId)
          ? citation.chunkId
          : undefined
        : documentOf(sources, keys, citation);
    if (key === undefined) {
      unpaired.push(i);
      return undefined;
    }
    if (mode === 'excerpt' && !numbers.has(key)) numbers.set(key, numbers.size + 1);
    uses.set(key, [...(uses.get(key) ?? []), i]);
    return key;
  });
  return { mode, numbers, targets, uses, unpaired };
};
