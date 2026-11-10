import { defineCatalogue, type Translation } from '@genai/i18n';
import * as approach from './approach/i18n.js';

/** Every block's words in one catalogue, for a host's own text; each block reads only its own. */
export const nb = defineCatalogue({ ...approach.nb });
export const en = { ...approach.en } satisfies Translation<typeof nb>;
