import type { ReactNode } from 'react';
import type { AnswerStatus } from '../answer/Answer.js';
import type { AnswerMarker } from '../answer/citations.js';
import type { SourceDocument } from '../sources/types.js';

/** What the reader asked. */
export interface ConversationQuestion {
  kind: 'question';
  id: string;
  text: string;
  /** The names of the documents the question was asked with. */
  attachments?: readonly string[] | undefined;
  /** The language the reader wrote in, when it is not the page's. */
  lang?: string | undefined;
}

/** One answer, as the contract sends it, with what the app knows about it. */
export interface ConversationAnswer {
  kind: 'answer';
  id: string;
  /** Markdown, with `[N]` footnotes. */
  text: string;
  status: AnswerStatus;
  /** The contract's `sources[]`; they come with the answer's end. */
  sources?: readonly SourceDocument[] | undefined;
  /** The contract's top-level `markers`, when the service cites excerpts. */
  markers?: readonly AnswerMarker[] | undefined;
  /** The text is the service's notice that it found nothing (`no_answer`), not an answer. */
  noAnswer?: boolean | undefined;
  /** When the answer came, as ISO 8601 or a date. Without it, no time is shown. */
  createdAt?: string | number | Date | undefined;
  /** The line over the answer: what the question was narrowed to, or where it was asked. */
  scope?: string | undefined;
}

/** The assistant asking for more before it answers (the contract's `clarification`). */
export interface ConversationClarification {
  kind: 'clarification';
  id: string;
  /** The question back, as Markdown. */
  text: string;
  /** Answers the service offers. The reader can always write their own in the question field. */
  options?: readonly string[] | undefined;
  /** The line over the question back, as over an answer: it was searched with the same filter. */
  scope?: string | undefined;
}

export type ConversationTurn =
  ConversationQuestion | ConversationAnswer | ConversationClarification;

/** A footnote to scroll to and focus: which answer, and its index in that answer's footnotes. */
export interface ConversationTarget {
  turnId: string;
  citation: number;
}

/** What the conversation hands the app's row under a finished answer. */
export interface ConversationActionParts {
  /** When the answer came, for the far end of the row: `AnswerActions`' `end`. */
  end: ReactNode;
  /** «Søk i svaret», when the conversation searches answers: one of the row's actions. */
  search: ReactNode;
}
