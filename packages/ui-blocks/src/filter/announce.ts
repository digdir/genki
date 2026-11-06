import { createContext, useContext } from 'react';

/** The filter's live region, for a block drawn in its head (the corpus choice). One region, so
 * «Henter filtre» and what changed are read in the order they happen; two would speak in no set
 * order. Outside a filter a block keeps a region of its own. */
export const AnnounceContext = createContext<((text: string) => void) | undefined>(undefined);

export const useFilterAnnouncer = () => useContext(AnnounceContext);

const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/** The text to put in a live region: the same words twice would not change the region, and it
 * would stay silent, so a no-break space makes them new. */
export const freshText = (previous: string, text: string) =>
  previous === text ? `${text}${NO_BREAK_SPACE}` : text;
