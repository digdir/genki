// Where a document lives, from its number, when the source carries no link: the host's function,
// or the collection's link templates, which are data a layout or a stored profile can hold.
import type { CorpusProfile, DocumentIdPattern } from './profile.js';

// The patterns a template can be keyed by, tried in this order. Fixed here, never built from a
// profile: a stored profile is not trusted to bring a regular expression.
const patterns: readonly (readonly [DocumentIdPattern, RegExp])[] = [
  ['digits', /^\d+$/],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['any', /^/],
];

/** The template's address with the number in it, when it is a web address; nothing else. */
const filled = (template: string, documentId: string): string | undefined => {
  const url = template.split('{id}').join(encodeURIComponent(documentId));
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A document's link from its number: the profile's `documentUrl` first, then the first of its
 * `documentLinks` whose pattern the number fits. Only an http or https address is a link.
 */
export const documentLink = (
  corpus: CorpusProfile | undefined,
  documentId: string,
): string | undefined => {
  const given = corpus?.documentUrl?.(documentId);
  if (given) return given;
  const links = corpus?.documentLinks;
  if (!links) return undefined;
  for (const [pattern, test] of patterns) {
    const template = links[pattern];
    if (template !== undefined && test.test(documentId)) return filled(template, documentId);
  }
  return undefined;
};
