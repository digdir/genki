import { defineCatalogue, type Translation } from '@genai/i18n';
import * as answer from './answer/i18n.js';
import * as conversation from './conversation/i18n.js';
import * as documentView from './document-view/i18n.js';
import * as shared from './i18n.js';
import * as sources from './sources/i18n.js';

/**
 * Every block's words in one catalogue, exported as `uiBlocksNb` and `uiBlocksEn`, for a host that
 * writes its own text with them, as `@genai/ui-assembly` does. No block reads it: a block reads its
 * own catalogue, so a host that imports one block loads only that block's words.
 */
export const nb = defineCatalogue({
  ...shared.nb,
  ...sources.nb,
  ...answer.nb,
  ...conversation.nb,
  ...documentView.nb,
});
export const en = {
  ...shared.en,
  ...sources.en,
  ...answer.en,
  ...conversation.en,
  ...documentView.en,
} satisfies Translation<typeof nb>;
