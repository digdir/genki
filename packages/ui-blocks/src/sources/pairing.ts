import type { SourceDocument } from './types.js';

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
  /** The mode drawn: excerpt mode needs every footnote to name its excerpt. */
  mode: CitationMode;
  /**
   * Each cited item's number, 1, 2, 3 in the order of first citation: excerpts in excerpt mode,
   * documents in document mode. Footnotes are always numbers; documents get them only while the
   * service cites documents, since then the document is what a footnote points at.
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
 * nowhere is reported, never guessed.
 */
export const pairCitations = (
  sources: readonly SourceDocument[],
  citations: readonly SourceCitation[],
  wanted: CitationMode = 'excerpt',
): Pairing => {
  const mode: CitationMode =
    wanted === 'excerpt' && citesExcerpts(citations) ? 'excerpt' : 'document';
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
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    uses.set(key, [...(uses.get(key) ?? []), i]);
    return key;
  });
  return { mode, numbers, targets, uses, unpaired };
};
