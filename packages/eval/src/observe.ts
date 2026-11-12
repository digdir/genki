import type { Event, Part } from '@genai/contracts';
import type { SourceRef } from './schema.js';

export interface ObservedSource extends SourceRef {
  url?: string;
  title?: string;
  text?: string;
}

export interface ObservedDecision {
  rule?: string;
  question: string;
  answer: string;
  probability?: number;
  refusal: boolean;
  outcome?: string;
}

export interface Observation {
  answer: string;
  retrieved: ObservedSource[];
  citations: ObservedSource[];
  fields?: Record<string, unknown>;
  decisions?: ObservedDecision[];
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
        ...(typeof s.page === 'number' ? { page: s.page } : {}),
        ...(typeof s.url === 'string' ? { url: s.url } : {}),
        ...(typeof s.title === 'string' ? { title: s.title } : {}),
        ...(typeof s.text === 'string' ? { text: s.text } : {}),
      },
    ];
  });
};

const besideTheAnswer = new Set([
  'application/vnd.genai.sources+json',
  'application/vnd.genai.retrieval+json',
  'application/vnd.genai.provenance+json',
]);

export const defaultObserve: Observe = (parts, events) => {
  const answer = parts
    .flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : []))
    .join('\n')
    .trim();
  // Sources, retrieval and the guard's provenance ride beside any answer, never as its fields.
  const json = parts.flatMap((p) =>
    p.body.kind === 'json' && !besideTheAnswer.has(p.mime) ? [p.body.json] : [],
  );
  const fields = json.find(
    (j): j is Record<string, unknown> => typeof j === 'object' && j !== null && !Array.isArray(j),
  );
  const retrieved = [
    ...events.flatMap((e) => {
      const d = e.data as { kind?: string; hits?: unknown } | undefined;
      return e.type === 'kernel.notice' && d?.kind === 'retrieval' ? asSources(d.hits) : [];
    }),
    ...parts.flatMap((p) => asSources(p.meta?.retrieved)),
    ...parts.flatMap((p) =>
      p.mime === 'application/vnd.genai.sources+json' && p.body.kind === 'json'
        ? asSources((p.body.json as { sources?: unknown } | null)?.sources)
        : [],
    ),
  ];
  const citations = parts.flatMap((p) => asSources(p.meta?.citations));
  const decisions = events.flatMap((e): ObservedDecision[] => {
    const d = e.data as Record<string, unknown> | undefined;
    if (e.type !== 'kernel.notice' || d?.kind !== 'decision') return [];
    return [
      {
        ...(typeof d.rule === 'string' ? { rule: d.rule } : {}),
        question: String(d.question ?? ''),
        answer: String(d.answer ?? ''),
        ...(typeof d.probability === 'number' ? { probability: d.probability } : {}),
        refusal: d.refusal === true,
        ...(typeof d.outcome === 'string' ? { outcome: d.outcome } : {}),
      },
    ];
  });
  return {
    answer,
    retrieved,
    citations,
    ...(fields ? { fields } : {}),
    ...(decisions.length ? { decisions } : {}),
  };
};

export const sameSource = (expected: SourceRef, actual: SourceRef) => {
  if (expected.chunkId !== undefined && actual.chunkId !== undefined) {
    if (expected.chunkId === actual.chunkId) return true;
    // A copy into another engine gives chunks new ids and keeps their document and position, so a
    // chunk id that differs is matched by those, never by the document alone.
    if (expected.position === undefined) return false;
  }
  if (expected.document === undefined || actual.document === undefined) return false;
  // An index from before the source renumbered names the document by its earlier id.
  if (expected.document !== actual.document && expected.earlierDocument !== actual.document)
    return false;
  if (expected.position !== undefined && expected.position !== actual.position) return false;
  // Only an index that knows pages is held to the page; an older one is matched by document.
  return expected.page === undefined || actual.page === undefined || expected.page === actual.page;
};
