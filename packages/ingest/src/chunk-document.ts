import {
  fixedWidthChunks,
  headerBasedChunks,
  type MetadataStyle,
  type RawChunk,
} from './chunking.js';
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
  /** The PDF page the chunk comes from, counted from 1; only the page strategy sets it. */
  page?: number;
}

export interface Location {
  key: 'url' | 'path' | 'page_guid';
  value: string;
}

// Marker writes `{n}` and a line of 48 dashes before page n, counted from 0
const pageMarker = /\{(\d+)\}\n+-{48}\n+/g;

// Parts joined greedily into pieces of at most `max` characters
const pack = (parts: string[], joiner: string, max: number): string[] => {
  const pieces: string[] = [];
  let current = '';
  for (const part of parts) {
    const joined = current === '' ? part : `${current}${joiner}${part}`;
    if (joined.length <= max || current === '') current = joined;
    else {
      pieces.push(current);
      current = part;
    }
  }
  return current === '' ? pieces : [...pieces, current];
};

// Split at the largest unit that fits: paragraphs, then sentences, then words. A Markdown table has no
// blank line inside, so it stays whole unless it alone is longer than the limit
const splitLevels: [RegExp, string][] = [
  [/\n{2,}/, '\n\n'],
  [/(?<=[.!?])\s+/, ' '],
  [/\s+/, ' '],
];

const pieces = (text: string, max: number, level = 0): string[] => {
  const split = splitLevels[level];
  if (text.length <= max) return [text];
  if (!split) return fixedWidthChunks(text, max, 0).map((chunk) => chunk.content_markdown);
  const [separator, joiner] = split;
  return pack(
    text.split(separator).flatMap((part) => pieces(part, max, level + 1)),
    joiner,
    max,
  );
};

// A text without Marker's page markers (another converter) is chunked the same way, with no page number
const pageChunks = (text: string, max: number): (RawChunk & { page?: number })[] => {
  const marks = [...text.matchAll(pageMarker)];
  if (marks.length === 0)
    return text.trim() === ''
      ? []
      : pieces(text.trim(), max).map((piece) => ({ content_markdown: piece }));
  return marks.flatMap((mark, i) => {
    const page = text.slice(mark.index + mark[0].length, marks[i + 1]?.index).trim();
    return page === ''
      ? []
      : pieces(page, max).map((piece) => ({
          content_markdown: piece,
          page: Number(mark[1]) + 1,
        }));
  });
};

const raw = (config: ChunkDocumentConfig, text: string): RawChunk[] =>
  config.strategy.kind === 'page'
    ? pageChunks(text, config.strategy.splitMaxLength ?? config.maximumLength)
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
