import { plainHeading, publicSourceUrl, sourceBreadcrumb, type Part } from '@genai/contracts';

/** The part strategies add to a result with the sources it searched and cited. */
export const SOURCES_MIME = 'application/vnd.genai.sources+json';
const FIELDS_MIME = 'application/json';
/** How many retrieved documents an uncited answer lists, as the frontend contract does. */
export const retrievedLimit = 10;

interface SourceRecord {
  chunkId: string;
  title?: string;
  url?: string;
  text?: string;
  headers?: string[];
  document?: string;
  position?: number;
  publishedAt?: string;
}

/** One source as the workspace shows it: title, path in the document, link, date and excerpt. */
export interface TraceSource {
  index?: number;
  title: string;
  breadcrumb?: string;
  url?: string;
  document_id?: string;
  published_at?: string;
  chunk_id: string;
  excerpt?: string;
}

/** What the trace's root observation carries as output when content is opted in. */
export interface TraceOutput {
  answer: string;
  /** The sources the answer cites as [N], in order of N. */
  citations: TraceSource[];
  /** When nothing is cited: up to `retrievedLimit` retrieved documents, one per document. */
  retrieved?: TraceSource[];
  /** A structured answer, for services that fill fields or tables. */
  fields?: Record<string, unknown>;
  no_answer?: true;
}

const isRecord = (v: unknown): v is SourceRecord =>
  typeof v === 'object' && v !== null && typeof (v as { chunkId?: unknown }).chunkId === 'string';

const sourcesOf = (parts: Part[]): SourceRecord[] =>
  parts.flatMap((p) => {
    if (p.mime !== SOURCES_MIME || p.body.kind !== 'json') return [];
    const list = (p.body.json as { sources?: unknown } | null)?.sources;
    return Array.isArray(list) ? list.filter(isRecord) : [];
  });

const citationsOf = (parts: Part[]): { index: number; chunkId: string }[] => {
  const marked = parts.find(
    (p) => p.mime !== SOURCES_MIME && Array.isArray((p.meta as { citations?: unknown })?.citations),
  );
  if (!marked) return [];
  return ((marked.meta as { citations: unknown[] }).citations ?? [])
    .filter(
      (c): c is { index: number; chunkId: string } =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { chunkId?: unknown }).chunkId === 'string' &&
        typeof (c as { index?: unknown }).index === 'number',
    )
    .sort((a, b) => a.index - b.index);
};

const byDocument = (records: SourceRecord[]) => {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = r.document ?? r.chunkId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const openable = (url: string | undefined) =>
  url !== undefined && /^https?:\/\//i.test(url) ? url : undefined;

const traceSource = (r: SourceRecord, index?: number): TraceSource => {
  const title = plainHeading(r.title ?? r.headers?.[0] ?? '') || 'Untitled source';
  const breadcrumb = sourceBreadcrumb(r.headers);
  const url = openable(publicSourceUrl(r));
  const excerpt = r.text?.trim();
  return {
    ...(index === undefined ? {} : { index }),
    title,
    ...(breadcrumb === undefined || breadcrumb === title ? {} : { breadcrumb }),
    ...(url === undefined ? {} : { url }),
    ...(r.document === undefined ? {} : { document_id: r.document }),
    ...(r.publishedAt ? { published_at: r.publishedAt } : {}),
    chunk_id: r.chunkId,
    ...(excerpt ? { excerpt } : {}),
  };
};

const fieldsOf = (parts: Part[]): Record<string, unknown> | undefined => {
  const part = parts.find((p) => p.mime === FIELDS_MIME && p.body.kind === 'json');
  const json = part?.body.kind === 'json' ? part.body.json : undefined;
  return typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : undefined;
};

/** The cited sources of a result, resolved to records, in order of [N]. */
export const citedSources = (parts: Part[]): TraceSource[] => {
  const byId = new Map(sourcesOf(parts).map((r) => [r.chunkId, r]));
  return citationsOf(parts).flatMap((c) => {
    const found = byId.get(c.chunkId);
    return found ? [traceSource(found, c.index)] : [];
  });
};

/**
 * The root observation's output: the answer and its sources as the workspace shows them, so an
 * evaluator can judge the answer against what it cites. Only sent when content is opted in.
 */
export const traceOutput = (parts: Part[]): TraceOutput => {
  const answer = parts
    .flatMap((p) => (p.body.kind === 'text' && p.mime !== SOURCES_MIME ? [p.body.text] : []))
    .join('');
  const citations = citedSources(parts);
  const retrieved = citations.length
    ? undefined
    : byDocument(sourcesOf(parts))
        .slice(0, retrievedLimit)
        .map((r) => traceSource(r));
  const fields = fieldsOf(parts);
  const noAnswer =
    answer.trim() === '' && (!fields || Object.keys(fields).length === 0)
      ? true
      : parts.some((p) => (p.meta as { noAnswer?: unknown } | undefined)?.noAnswer === true) ||
        undefined;
  return {
    answer,
    citations,
    ...(retrieved?.length ? { retrieved } : {}),
    ...(fields ? { fields } : {}),
    ...(noAnswer ? { no_answer: true } : {}),
  };
};
