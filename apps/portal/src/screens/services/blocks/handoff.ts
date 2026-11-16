import { keepStart, keptStart, readStart, type BlocksStart } from './layoutStore';

// «Lag en tjeneste av dette» in the playground hands its layout to the new service it goes on to.
const key = 'genki.blocks.handoff';

/** The service id the playground keeps its own layout under. */
export const playgroundLayout = 'playground';

/** Keeps the playground's layout for the new service the person goes on to make. */
export const handOver = (start: BlocksStart) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(start));
  } catch {
    // Without storage the new service starts from the default template.
  }
};

/**
 * Gives a new service the layout handed over, unless it already keeps one. The layout stays handed
 * over while the service is still `new`, so it follows the draft once the draft has an id.
 */
export const takeOver = (tenant: string, service: string) => {
  try {
    const start = readStart(sessionStorage.getItem(key));
    if (!start) return;
    if (!keptStart(tenant, service)) keepStart(tenant, service, start);
    if (service !== 'new') sessionStorage.removeItem(key);
  } catch {
    // Without storage there is nothing handed over.
  }
};

