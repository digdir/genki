import { plainHeading, publicSourceUrl, sourceBreadcrumb, type Part } from '@genai/contracts';

export const SOURCES_MIME = 'application/vnd.genai.sources+json';

export interface SourceRecord {
  chunkId: string;
  title?: string;
  url?: string;
  text?: string;
  headers?: string[];
  document?: string;
  position?: number;
  version?: string | number;
  publishedAt?: string;
}

export interface OwuiSource {
  source: { name: string; id: string; url: string };
  document: string[];
  metadata: { source: string; chunk_id: string; name?: string }[];
  excerpt?: string;
  index?: number;
  title: string;
  url?: string;
  document_id?: string;
  excerpts: SourceExcerpt[];
  version?: string;
  published_at?: string;
}

export interface SourceExcerpt {
  chunk_id: string;
  text: string;
  position?: number;
}

export const excerptLength = 300;

export const openable = (url: string | undefined) =>
  url !== undefined && /^https?:\/\//i.test(url) ? url : undefined;

export const excerptOf = (text: string | undefined, max = excerptLength): string | undefined => {
  const flat = (text ?? '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return undefined;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

export const provenanceOf = (record: SourceRecord) => ({
  ...(record.version === undefined || record.version === ''
    ? {}
    : { version: String(record.version) }),
  ...(record.publishedAt ? { published_at: record.publishedAt } : {}),
});

export interface CitationBundle {
  citations: string[];
  sources: OwuiSource[];
}

const isRecord = (v: unknown): v is SourceRecord =>
  typeof v === 'object' && v !== null && typeof (v as { chunkId?: unknown }).chunkId === 'string';

export const sourcesOf = (parts: Part[]): SourceRecord[] =>
  parts.flatMap((p) => {
    if (p.mime !== SOURCES_MIME || p.body.kind !== 'json') return [];
    const list = (p.body.json as { sources?: unknown } | null)?.sources;
    return Array.isArray(list) ? list.filter(isRecord) : [];
  });

export interface CitedRecord {
  record: SourceRecord;
  index?: number;
}

const citedWithIndex = (parts: Part[]): CitedRecord[] => {
  const records = sourcesOf(parts);
  const marked = parts.find(
    (p) =>
      p.mime !== SOURCES_MIME &&
      Array.isArray((p.meta as { citations?: unknown } | undefined)?.citations),
  );
  if (!marked) return records.map((record) => ({ record }));
  const citations = (marked.meta as { citations: unknown[] }).citations
    .filter(
      (c): c is { index: number; chunkId: string } =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { chunkId?: unknown }).chunkId === 'string' &&
        typeof (c as { index?: unknown }).index === 'number',
    )
    .sort((a, b) => a.index - b.index);
  const byId = new Map(records.map((r) => [r.chunkId, r]));
  return citations.flatMap((c) => {
    const found = byId.get(c.chunkId);
    return found ? [{ record: found, index: c.index }] : [];
  });
};

export const citedOf = (parts: Part[]): SourceRecord[] =>
  citedWithIndex(parts).map((c) => c.record);

export const retrievedLimit = 10;

const byDocument = (records: SourceRecord[]) => {
  const seen = new Set<string>();
  return records.filter((r) => {
    const key = r.document ?? r.chunkId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const answerSourcesOf = (parts: Part[]): { cited: CitedRecord[]; retrieved: boolean } => {
  const cited = citedWithIndex(parts);
  if (cited.length) return { cited, retrieved: false };
  return {
    cited: byDocument(sourcesOf(parts))
      .slice(0, retrievedLimit)
      .map((record) => ({ record })),
    retrieved: true,
  };
};

export const FIELDS_MIME = 'application/json';
export const NO_ANSWER_NOTICE = 'Fant ikke noe svar.';

export const fieldsOf = (parts: Part[]): Record<string, unknown> | undefined => {
  const part = parts.find((p) => p.mime === FIELDS_MIME && p.body.kind === 'json');
  const json = part?.body.kind === 'json' ? part.body.json : undefined;
  return typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : undefined;
};

export const answerOf = (parts: Part[]): string => {
  const text = parts
    .flatMap((p) => (p.body.kind === 'text' && p.mime !== SOURCES_MIME ? [p.body.text] : []))
    .join('');
  if (text.trim()) return text;
  const fields = fieldsOf(parts);
  if (!fields || Object.keys(fields).length === 0) return text;
  return typeof fields.text === 'string' && fields.text.trim()
    ? fields.text
    : JSON.stringify(fields, null, 2);
};

export const noAnswerOf = (parts: Part[]) => answerOf(parts).trim() === '';

export const noAnswerMarker = (parts: Part[]) =>
  noAnswerOf(parts) ? { no_answer: true as const, notice: NO_ANSWER_NOTICE } : {};

const excerptsOf = (record: SourceRecord, pool: SourceRecord[]): SourceExcerpt[] => {
  const siblings =
    record.document === undefined
      ? []
      : pool
          .filter((p) => p.document === record.document && p.chunkId !== record.chunkId)
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return [record, ...siblings].flatMap((r) =>
    r.text === undefined || r.text.trim() === ''
      ? []
      : [
          {
            chunk_id: r.chunkId,
            text: r.text,
            ...(r.position === undefined ? {} : { position: r.position }),
          },
        ],
  );
};

export const citationBundle = (
  records: (SourceRecord | CitedRecord)[],
  pool: SourceRecord[] = [],
): CitationBundle => {
  const resolved = records.map((entry) => {
    const { record: r, index } = 'record' in entry ? entry : { record: entry, index: undefined };
    const title = plainHeading(r.title ?? r.headers?.[0] ?? '') || 'Untitled source';
    return {
      index,
      chunkId: r.chunkId,
      title,
      url: publicSourceUrl(r) ?? `chunk:${r.chunkId}`,
      breadcrumb: sourceBreadcrumb(r.headers),
      text: r.text,
      excerpt: excerptOf(r.text),
      provenance: provenanceOf(r),
      publicUrl: openable(publicSourceUrl(r)),
      documentId: r.document,
      excerpts: excerptsOf(r, pool),
    };
  });
  return {
    citations: resolved.flatMap((r) => (r.publicUrl === undefined ? [] : [r.publicUrl])),
    sources: resolved.map((r) => ({
      source: { name: r.title, id: r.chunkId, url: r.url },
      document: r.text === undefined ? [] : [r.text],
      metadata: [
        {
          source: r.chunkId,
          chunk_id: r.chunkId,
          ...(r.breadcrumb === undefined
            ? {}
            : {
                name: r.breadcrumb.startsWith(r.title)
                  ? r.breadcrumb
                  : `${r.title} › ${r.breadcrumb}`,
              }),
        },
      ],
      ...(r.excerpt === undefined ? {} : { excerpt: r.excerpt }),
      ...(r.index === undefined ? {} : { index: r.index }),
      title: r.title,
      ...(r.publicUrl === undefined ? {} : { url: r.publicUrl }),
      ...(r.documentId === undefined ? {} : { document_id: r.documentId }),
      excerpts: r.excerpts,
      ...r.provenance,
    })),
  };
};
