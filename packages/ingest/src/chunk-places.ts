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

interface Line {
  text: string;
  start: number;
  end: number;
}

/** A text's lines with where each starts and ends, leaving out blank lines and page separators. */
const linesAt = (text: string): Line[] => {
  const out: Line[] = [];
  let at = 0;
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed !== '' && !/^-+$/.test(trimmed)) {
      const start = at + raw.indexOf(trimmed);
      out.push({ text: trimmed, start, end: start + trimmed.length - 1 });
    }
    at += raw.length + 1;
  }
  return out;
};

const heading = /^#{1,6}\s/;

/**
 * Where a chunk's lines lie in its text, matched in order from a line on: a chunk leaves out the
 * heading lines it was split at, so those are stepped over. Undefined when its lines are not there.
 */
const matchFrom = (source: Line[], from: number, own: string[]) => {
  let j = 0;
  let k = from;
  let last = from;
  while (j < own.length && k < source.length) {
    const line = source[k] as Line;
    if (line.text.includes(own[j] as string)) {
      last = k;
      j++;
      k++;
    } else if (j > 0 && heading.test(line.text)) k++;
    else return undefined;
  }
  return j === own.length ? { first: from, last } : undefined;
};

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
 * its text by all its lines in order, so a running header on every page does not place it on an
 * earlier page, and one that cannot be found takes the place of the chunk before it.
 */
export const placeChunks = (
  doc: IndexDocument,
  source: Pick<SourceDocument, 'texts' | 'files'>,
): IndexDocument => {
  const texts = source.texts;
  const starts = texts.map((text, i) => pageStarts(source.files?.[i]?.pages ?? [text]));
  const sourceLines = texts.map(linesAt);
  let cursor = { text: 0, line: 0 };
  let last: Place = { text: 0, from: 1, to: 1 };
  const place = (chunk: IndexChunk): Place => {
    const own = lines(chunk.text);
    const first = own[0];
    if (!first) return last;
    for (let t = cursor.text; t < texts.length; t++) {
      const source = sourceLines[t] ?? [];
      const pages = starts[t] ?? [0];
      let fallback: number | undefined;
      for (let i = t === cursor.text ? cursor.line : 0; i < source.length; i++) {
        if (!(source[i] as Line).text.includes(first)) continue;
        fallback ??= i;
        const found = matchFrom(source, i, own);
        if (!found) continue;
        cursor = { text: t, line: i };
        return {
          text: t,
          from: pageAt(pages, (source[found.first] as Line).start),
          to: pageAt(pages, (source[found.last] as Line).end),
        };
      }
      // Lines that do not all match, as when a chunk was cut inside a line, place it by its first.
      if (fallback !== undefined) {
        cursor = { text: t, line: fallback };
        const at = pageAt(pages, (source[fallback] as Line).start);
        return { text: t, from: at, to: at };
      }
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
