import type { TemplateEvent } from '@genai/contracts/block-template';
import { createContext } from 'react';

export interface BlockHost {
  locale: 'nb' | 'nn' | 'en';
  onEvent: (event: TemplateEvent) => void;
}

/** The host's handlers for the events of the ref blocks below it. */
export const BlockHostContext = createContext<BlockHost>({
  locale: 'nb',
  onEvent: () => undefined,
});
