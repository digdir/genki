import type { Part } from '@genai/contracts';

export const SOURCES_MIME = 'application/vnd.genai.sources+json';

export interface SourceRecord {
  chunkId: string;
  title?: string;
  url?: string;
  text?: string;
  headers?: string[];
  document?: string;
  position?: number;
  version?: string;
  publishedAt?: string;
}

export interface Clarification {
  question: string;
  options: string[] | null;
  'context-summary': string;
}

export const sourcesPart = (
  sources: SourceRecord[],
  clarification?: Clarification,
  extra: { filtersApplied?: unknown[]; insufficient?: boolean; executionMetadata?: unknown } = {},
): Part => ({
  mime: SOURCES_MIME,
  body: {
    kind: 'json',
    json: {
      sources,
      ...(clarification ? { clarification } : {}),
      ...(extra.filtersApplied?.length ? { filtersApplied: extra.filtersApplied } : {}),
      ...(extra.insufficient === undefined ? {} : { insufficient: extra.insufficient }),
      ...(extra.executionMetadata === undefined
        ? {}
        : { executionMetadata: extra.executionMetadata }),
    },
  },
});
