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
  markers?: string[];
  version?: string;
  published_at?: string;
}

export interface SourceExcerpt {
  chunk_id: string;
  text: string;
  position?: number;
  markers?: string[];
}

export interface AnswerMarker {
  marker: string;
  chunk_id: string;
  document: string;
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
  markers?: string[];
  excerptMarkers?: Map<string, string[]>;
}

interface PartCitation {
  index: number;
  chunkId: string;
  document?: string;
}

const markedPart = (parts: Part[]) =>
  parts.find(
    (p) =>
      p.mime !== SOURCES_MIME &&
      Array.isArray((p.meta as { citations?: unknown } | undefined)?.citations),
  );

const citationsIn = (part: Part): PartCitation[] =>
  (part.meta as { citations: unknown[] }).citations
    .filter(
      (c): c is PartCitation =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as { chunkId?: unknown }).chunkId === 'string' &&
        typeof (c as { index?: unknown }).index === 'number',
    )
    .sort((a, b) => a.index - b.index);

const citesExcerpts = (part: Part) => (part.meta as { citeBy?: unknown }).citeBy === 'excerpt';

export const markersOf = (parts: Part[]): AnswerMarker[] => {
  const marked = markedPart(parts);
  if (!marked || !citesExcerpts(marked)) return [];
  const byId = new Map(sourcesOf(parts).map((r) => [r.chunkId, r]));
  return citationsIn(marked).flatMap((c) => {
    const found = byId.get(c.chunkId);
    return found
      ? [
          {
            marker: String(c.index),
            chunk_id: c.chunkId,
            document: c.document ?? found.document ?? c.chunkId,
          },
        ]
      : [];
  });
};

const citedByDocument = (parts: Part[]): CitedRecord[] => {
  const byId = new Map(sourcesOf(parts).map((r) => [r.chunkId, r]));
  const groups = new Map<
    string,
    Required<Omit<CitedRecord, 'record'>> & { record: SourceRecord }
  >();
  for (const m of markersOf(parts)) {
    const group = groups.get(m.document) ?? {
      record: byId.get(m.chunk_id) as SourceRecord,
      index: Number(m.marker),
      markers: [],
      excerptMarkers: new Map<string, string[]>(),
    };
    group.markers.push(m.marker);
    group.excerptMarkers.set(m.chunk_id, [
      ...(group.excerptMarkers.get(m.chunk_id) ?? []),
      m.marker,
    ]);
    groups.set(m.document, group);
  }
  return [...groups.values()];
};

const citedWithIndex = (parts: Part[]): CitedRecord[] => {
  const records = sourcesOf(parts);
  const marked = markedPart(parts);
  if (!marked) return records.map((record) => ({ record }));
  if (citesExcerpts(marked)) return citedByDocument(parts);
  const byId = new Map(records.map((r) => [r.chunkId, r]));
  return citationsIn(marked).flatMap((c) => {
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

const markersFor = (marked: Map<string, string[]> | undefined, chunkId: string) => {
  const found = marked?.get(chunkId);
  return found ? { markers: found } : {};
};

const excerptsOf = (
  record: SourceRecord,
  pool: SourceRecord[],
  marked?: Map<string, string[]>,
): SourceExcerpt[] => {
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
            ...markersFor(marked, r.chunkId),
          },
        ],
  );
};

export const citationBundle = (
  records: (SourceRecord | CitedRecord)[],
  pool: SourceRecord[] = [],
): CitationBundle => {
  const resolved = records.map((entry) => {
    const {
      record: r,
      index,
      markers,
      excerptMarkers,
    } = 'record' in entry ? entry : { record: entry, index: undefined };
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
      excerpts: excerptsOf(r, pool, excerptMarkers),
      markers,
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
      ...(r.markers === undefined ? {} : { markers: r.markers }),
      ...r.provenance,
    })),
  };
};
