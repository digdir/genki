import type { Channel } from '@genai/ui-blocks/builder';

/** A draft's frontend keeps this visit's threads and reads facets; it has nowhere to send feedback. */
export const draftChannels: readonly Channel[] = ['conversations', 'facets'];
