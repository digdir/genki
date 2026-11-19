// A document's link from its number: the host's function, then the collection's templates.
import { isSitePath } from '@genai/ui-blocks';
import type { CorpusProfile, DocumentIdPattern } from './profile.js';

// Tried in this order, and never built from a profile.
const patterns: readonly (readonly [DocumentIdPattern, RegExp])[] = [
  ['digits', /^\d+$/],
  ['uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['any', /^/],
];

/** The template's address with the number in it, when it is a web address or a path on this site. */
const filled = (template: string, documentId: string): string | undefined => {
  const url = template.split('{id}').join(encodeURIComponent(documentId));
  if (isSitePath(template)) return url;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
};

/** `documentUrl`, else the first of `documentLinks` the number fits; http, https or this site. */
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
