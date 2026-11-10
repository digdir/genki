/** What the try view runs: a draft, or without one the playground's own first setup. */
export interface DraftSource {
  definition?: Record<string, unknown> | undefined;
  files?: Record<string, string> | undefined;
}

/** The service id the try view names: the draft's own, or the playground's. */
export const draftServiceOf = (source: DraftSource | undefined) => {
  const id = (source?.definition?.metadata as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && id ? id : 'playground';
};
