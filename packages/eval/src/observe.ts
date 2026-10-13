import type { Event, Part } from '@genai/contracts';
import type { SourceRef } from './schema.js';

export interface ObservedSource extends SourceRef {
  url?: string;
}

export interface Observation {
  answer: string;
  retrieved: ObservedSource[];
  citations: ObservedSource[];
  fields?: Record<string, unknown>;
}

export type Observe = (parts: Part[], events: Event[]) => Observation;

const asSources = (value: unknown): ObservedSource[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (typeof v !== 'object' || v === null) return [];
    const s = v as Record<string, unknown>;
    const chunkId =
      typeof s.chunkId === 'string' ? s.chunkId : typeof s.id === 'string' ? s.id : undefined;
    const document = typeof s.document === 'string' ? s.document : undefined;
    if (chunkId === undefined && document === undefined) return [];
    return [
      {
        ...(chunkId === undefined ? {} : { chunkId }),
        ...(document === undefined ? {} : { document }),
        ...(typeof s.position === 'number' ? { position: s.position } : {}),
        ...(typeof s.url === 'string' ? { url: s.url } : {}),
      },
    ];
  });
};

export const defaultObserve: Observe = (parts, events) => {
  const answer = parts
    .flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : []))
    .join('\n')
    .trim();
  const json = parts.flatMap((p) => (p.body.kind === 'json' ? [p.body.json] : []));
  const fields = json.find(
    (j): j is Record<string, unknown> => typeof j === 'object' && j !== null && !Array.isArray(j),
  );
  const retrieved = [
    ...events.flatMap((e) => {
      const d = e.data as { kind?: string; hits?: unknown } | undefined;
      return e.type === 'kernel.notice' && d?.kind === 'retrieval' ? asSources(d.hits) : [];
    }),
    ...parts.flatMap((p) => asSources(p.meta?.retrieved)),
  ];
  const citations = parts.flatMap((p) => asSources(p.meta?.citations));
  return { answer, retrieved, citations, ...(fields ? { fields } : {}) };
};

export const sameSource = (expected: SourceRef, actual: SourceRef) => {
  if (expected.chunkId !== undefined && actual.chunkId !== undefined)
    return expected.chunkId === actual.chunkId;
  if (expected.document === undefined || actual.document === undefined) return false;
  if (expected.document !== actual.document) return false;
  return expected.position === undefined || expected.position === actual.position;
};
