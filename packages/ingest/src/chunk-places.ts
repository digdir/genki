import { shortHash } from '@genai/valuehash';
import type { IndexChunk, IndexDocument } from '@genai/port-knowledge';
import { markerPageSeparator } from './converter.js';
import type { SourceDocument } from './pipeline.js';

/**
 * A chunk's id in the knowledge database: its document id, file, page and position (ADR 0042,
 * "Identity and chunks"), so two documents never share a chunk id, even with the same text.
 */
export const knowledgeChunkId = (
  documentId: string,
  file: string,
  page: number,
  position: number,
) => shortHash(`${documentId}|${file}|${page}|${position}`);

/** Where each page of a text starts, with the separator the pages were joined with. */
const pageStarts = (pages: readonly string[]) => {
  const starts: number[] = [];
  let at = 0;
  for (const page of pages) {
    starts.push(at);
    at += page.length + markerPageSeparator.length;
  }
  return starts;
};

const pageAt = (starts: number[], offset: number) => {
  let page = 1;
  starts.forEach((start, i) => {
    if (offset >= start) page = i + 1;
  });
  return page;
};

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^-+$/.test(l));

/** The headings in a chunk's header metadata (`{"Header 1" "…", "Header 2" "…"}`), outermost first. */
const headingPathOf = (metadata: unknown): string[] | undefined => {
  if (typeof metadata !== 'string') return undefined;
  const found = [...metadata.matchAll(/"Header (\d)" "((?:[^"\\]|\\.)*)"/g)]
    .map((m) => ({ level: Number(m[1]), text: (m[2] ?? '').replace(/\\(.)/g, '$1') }))
    .sort((a, b) => a.level - b.level)
    .map((h) => h.text);
  return found.length > 0 ? found : undefined;
};

interface Place {
  text: number;
  from: number;
  to: number;
}

/**
 * Gives each chunk of a document its file, the pages it spans, its heading path and its id in the
 * knowledge database. Chunks are cut from each file's joined pages as before; a chunk is found in
 * its text by its first and last line, in order, and one that cannot be found takes the place of
 * the chunk before it.
 */
export const placeChunks = (
  doc: IndexDocument,
  source: Pick<SourceDocument, 'texts' | 'files'>,
): IndexDocument => {
  const texts = source.texts;
  const starts = texts.map((text, i) => pageStarts(source.files?.[i]?.pages ?? [text]));
  let cursor = { text: 0, offset: 0 };
  let last: Place = { text: 0, from: 1, to: 1 };
  const place = (chunk: IndexChunk): Place => {
    const own = lines(chunk.text);
    const first = own[0];
    const end = own[own.length - 1];
    if (!first || !end) return last;
    for (let t = cursor.text; t < texts.length; t++) {
      const text = texts[t] ?? '';
      const start = text.indexOf(first, t === cursor.text ? cursor.offset : 0);
      if (start < 0) continue;
      const tail = text.indexOf(end, start);
      const stop = tail < 0 ? start : tail + end.length - 1;
      const pages = starts[t] ?? [0];
      cursor = { text: t, offset: start + 1 };
      return { text: t, from: pageAt(pages, start), to: pageAt(pages, stop) };
    }
    return last;
  };
  const ids = new Map<string, string>();
  const chunks = doc.chunks.map((chunk): IndexChunk => {
    last = place(chunk);
    const file = source.files?.[last.text];
    const name = file?.name ?? `text-${last.text + 1}`;
    const headingPath = headingPathOf(chunk.metadata?.metadata);
    const id = knowledgeChunkId(doc.id, file?.sha256 ?? name, last.from, chunk.position);
    ids.set(chunk.id, id);
    return {
      ...chunk,
      id,
      file: name,
      ...(file?.sha256 ? { fileSha256: file.sha256 } : {}),
      pageFrom: last.from,
      pageTo: last.to,
      ...(headingPath ? { headingPath } : {}),
    };
  });
  // Phrases point at their chunk by its new id.
  const phrases = doc.phrases.map((p) => ({ ...p, chunkId: ids.get(p.chunkId) ?? p.chunkId }));
  return { ...doc, chunks, phrases };
};
