import {
  fixedWidthChunks,
  headerBasedChunks,
  type MetadataStyle,
  type RawChunk,
} from './chunking.js';
import { markerPageSeparator } from './converter.js';
import { assignChunkIds } from './ids.js';

export type ChunkStrategy =
  | { kind: 'header-based'; splitMaxLength?: number; overlap?: number }
  | { kind: 'fixed-width'; width: number; overlap: number }
  | { kind: 'page'; splitMaxLength?: number };

export interface ChunkDocumentConfig {
  strategy: ChunkStrategy;
  minimumLength: number;
  maximumLength: number;
  metadataStyle: MetadataStyle;
}

export interface Chunk {
  chunk_id: string;
  content_markdown: string;
  metadata?: string;
  doc_num: string;
  chunk_index: number;
  content_length: number;
  url?: string;
  path?: string;
  page_guid?: string;
}

export interface Location {
  key: 'url' | 'path' | 'page_guid';
  value: string;
}

/** A slice of a page: pieces are cut from the page as written, so each is found on its page again. */
type Span = [start: number, end: number];

// The largest unit that fits: paragraphs, then lines, then sentences, then words. A Markdown table has
// no blank line inside, so it stays whole when it fits, and a longer one splits between its rows.
const splitLevels = [/\n{2,}/g, /\n/g, /(?<=[.!?])\s+/g, /\s+/g];

/** The parts of a span between the separators of one level, as spans of the page. */
const partsOf = (page: string, [start, end]: Span, separator: RegExp): Span[] => {
  const parts: Span[] = [];
  let from = start;
  for (const match of page.slice(start, end).matchAll(separator)) {
    const at = start + (match.index ?? 0);
    if (at > from) parts.push([from, at]);
    from = at + match[0].length;
  }
  if (end > from) parts.push([from, end]);
  return parts;
};

// Neighbouring spans joined greedily, with what lies between them, into spans of at most `max`.
const pack = (spans: Span[], max: number): Span[] => {
  const packed: Span[] = [];
  for (const span of spans) {
    const current = packed.at(-1);
    if (current && span[1] - current[0] <= max) current[1] = span[1];
    else packed.push([...span]);
  }
  return packed;
};

const spansOf = (page: string, span: Span, max: number, level = 0): Span[] => {
  if (span[1] - span[0] <= max) return [span];
  const separator = splitLevels[level];
  if (!separator) {
    const cut: Span[] = [];
    for (let at = span[0]; at < span[1]; at += max) cut.push([at, Math.min(at + max, span[1])]);
    return cut;
  }
  return pack(
    partsOf(page, span, separator).flatMap((part) => spansOf(page, part, max, level + 1)),
    max,
  );
};

const pieces = (page: string, max: number) =>
  spansOf(page, [0, page.length], max).map(([start, end]) => page.slice(start, end));

/** Each page on its own, never two in one chunk: a file's pages are joined with the page separator. */
const pageChunks = (text: string, max: number): RawChunk[] =>
  text
    .split(markerPageSeparator)
    .map((page) => page.trim())
    .filter((page) => page !== '')
    .flatMap((page) => pieces(page, max).map((piece) => ({ content_markdown: piece })));

const raw = (config: ChunkDocumentConfig, text: string): RawChunk[] =>
  config.strategy.kind === 'page'
    ? pageChunks(
        text,
        Math.min(config.strategy.splitMaxLength ?? config.maximumLength, config.maximumLength),
      )
    : config.strategy.kind === 'fixed-width'
      ? fixedWidthChunks(text, config.strategy.width, config.strategy.overlap)
      : headerBasedChunks(
          {
            minimumLength: config.minimumLength,
            splitMaxLength: config.strategy.splitMaxLength ?? config.maximumLength,
            ...(config.strategy.overlap === undefined ? {} : { overlap: config.strategy.overlap }),
          },
          text,
          config.metadataStyle,
        );

export const chunkDocument = (
  docNum: string,
  texts: string[],
  config: ChunkDocumentConfig,
  location?: Location,
): Chunk[] =>
  assignChunkIds(
    docNum,
    texts
      .flatMap((text) => raw(config, text))
      .filter(
        (c) =>
          c.content_markdown.length >= config.minimumLength &&
          c.content_markdown.length <= config.maximumLength,
      ),
  ).map((chunk, index) => ({
    ...chunk,
    doc_num: docNum,
    chunk_index: index,
    content_length: chunk.content_markdown.length,
    ...(location ? { [location.key]: location.value } : {}),
  }));
