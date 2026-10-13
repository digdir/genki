import {
  fixedWidthChunks,
  headerBasedChunks,
  type MetadataStyle,
  type RawChunk,
} from './chunking.js';
import { assignChunkIds } from './ids.js';

export type ChunkStrategy =
  | { kind: 'header-based'; splitMaxLength?: number; overlap?: number }
  | { kind: 'fixed-width'; width: number; overlap: number };

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

const raw = (config: ChunkDocumentConfig, text: string): RawChunk[] =>
  config.strategy.kind === 'fixed-width'
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
