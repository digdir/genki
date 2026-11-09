// What a host knows about its service that genki does not say: the assistant's name, its
// suggested questions, and per collection the labels of its filter fields and where a document
// lives. kunnskapsassistenten's own choices are one such profile; without one, the assembly uses
// genki's names as they come.

/** One filter field as the reader sees it. */
export interface FieldSpec {
  id: string;
  label: string;
  kind?: 'year' | undefined;
  /** The values are integers on the wire. */
  integer?: boolean | undefined;
}

export interface CorpusProfile {
  /** The collection's name in the page, «Kudos». */
  label?: string | undefined;
  description?: string | undefined;
  /** The fields offered and their order; the rest of the collection's fields are not. */
  fields?: readonly FieldSpec[] | undefined;
  /** The plural of each document type, for «Leser fra 45 778 årsrapporter». */
  typePlurals?: Readonly<Record<string, string>> | undefined;
  /** The field the document type is in, for the line above. */
  typeField?: string | undefined;
  /** Where a document lives, from its number, when the source carries no link. */
  documentUrl?: ((documentId: string) => string | undefined) | undefined;
  /**
   * The facets that describe one document, read by its number for the line under its title in
   * «Dokumenter»: the field holding the number, and the fields to show.
   */
  about?: { idField: string; fields: readonly string[] } | undefined;
}

export interface AssistantProfile {
  /** Who answers, in the page and for a screen reader. */
  assistantName?: string | undefined;
  /** The three questions offered under the greeting. */
  suggestions?: readonly string[] | undefined;
  /** The follow-ups offered over the field after an answer. */
  followUps?: readonly string[] | undefined;
  /** Per collection, by its key. */
  corpora?: Readonly<Record<string, CorpusProfile>> | undefined;
  /** Who the reader is, for «Innlogget som» under the threads. */
  signedInAs?: string | undefined;
}
