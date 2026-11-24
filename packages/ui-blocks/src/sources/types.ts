/** An excerpt as the frontend contract sends it, and what a host knows beyond it. */
export interface SourceExcerpt {
  chunkId: string;
  text: string;
  position?: number | undefined;
  /** Its section path, «Kapittel 3 › 3.4 Digitalisering». */
  heading?: string | undefined;
  page?: number | undefined;
  /** The page the excerpt ends on, when it runs on past `page`: «side 12–13». */
  pageEnd?: number | undefined;
  /** A «Les side N» link is drawn only when this opens that page, `#page=N`. */
  url?: string | undefined;
  textUnavailable?: boolean | undefined;
  textLoading?: boolean | undefined;
}

/** A source document as the frontend contract sends it (`sources[]`). */
export interface SourceDocument {
  index?: number | undefined;
  title: string;
  url?: string | undefined;
  documentId?: string | undefined;
  excerpts: readonly SourceExcerpt[];
  excerpt?: string | undefined;
  version?: string | undefined;
  publishedAt?: string | undefined;
  documentType?: string | undefined;
  publisher?: string | undefined;
  /** A host's own line under the title, instead of the block's. */
  meta?: readonly string[] | undefined;
}

export interface SourceSelection {
  source: SourceDocument;
  excerpt?: SourceExcerpt;
}

/** The words a footnote rests on, in its excerpt's text (W3C TextQuoteSelector, ADR 0052). */
export interface TextQuote {
  type: 'TextQuoteSelector';
  exact: string;
  prefix: string;
  suffix: string;
}

/** Where a footnote sends the reader. */
export interface SourceTarget {
  chunkId?: string | undefined;
  documentId?: string | undefined;
  index?: number | undefined;
  /** The words the footnote rests on, marked in the excerpt it opens. */
  quote?: TextQuote | undefined;
}
