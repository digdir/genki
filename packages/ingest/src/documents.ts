import { extname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ConversionPending,
  NoTextLayerError,
  isPdfFile,
  joinPages,
  type DocumentConverter,
  type DocumentFile,
} from './converter.js';
import { htmlToPage, type ContentExtractor } from './html.js';
import type { SkipReason } from './pipeline.js';

export const textExtensions: readonly string[] = ['.md', '.txt', '.html', '.htm'];

export const readableTextExtensions = ['.md', '.txt', '.html', '.htm', '.yaml', '.yml'] as const;

export const defaultConvertibleExtensions: readonly string[] = ['.pdf', '.docx'];

const unsearchableWebExtensions = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.zip',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.mp3',
  '.mp4',
]);

const mimeExtensions: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/html': '.html',
  'application/xhtml+xml': '.html',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

export const convertibleExtensions = (converter?: DocumentConverter): readonly string[] =>
  converter
    ? (converter.extensions ?? defaultConvertibleExtensions)
        .map((e) => e.toLowerCase())
        .filter((e) => !textExtensions.includes(e))
    : [];

export const skipReasonFor = (
  path: string,
  converter?: DocumentConverter,
  texts: readonly string[] = textExtensions,
): SkipReason | undefined => {
  const ext = extname(path).toLowerCase();
  return texts.includes(ext) || convertibleExtensions(converter).includes(ext)
    ? undefined
    : 'unsupported_type';
};

export const websiteSkipReasonFor = (
  url: string,
  converter?: DocumentConverter,
): SkipReason | undefined => {
  const ext = extname(new URL(url).pathname).toLowerCase();
  return unsearchableWebExtensions.has(ext) && !convertibleExtensions(converter).includes(ext)
    ? 'unsupported_type'
    : undefined;
};

/** A converted file's pages and hash, so its chunks can name the file and the pages they span. */
export interface ReadFile {
  name: string;
  sha256: string;
  pages: string[];
}

export type ReadDocument = { text: string; title?: string; file?: ReadFile } | { skip: SkipReason };

export interface ReadDocumentOptions {
  converter?: DocumentConverter;
  extract?: ContentExtractor;
  defaultExtension?: string;
  textExtensions?: readonly string[];
}

const kindOf = (file: DocumentFile, fallback = '') => {
  const mime = (file.mimetype ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return mimeExtensions[mime] ?? (extname(file.name).toLowerCase() || fallback);
};

export const readDocument = async (
  file: DocumentFile,
  options: ReadDocumentOptions = {},
): Promise<ReadDocument> => {
  const kind = kindOf(file, options.defaultExtension);
  const read = async (): Promise<ReadDocument> => {
    if (kind === '.html' || kind === '.htm') {
      const page = htmlToPage(
        new TextDecoder().decode(file.bytes),
        options.extract ? { extract: options.extract } : {},
      );
      return { text: page.markdown, ...(page.title ? { title: page.title } : {}) };
    }
    if ((options.textExtensions ?? textExtensions).includes(kind))
      return { text: new TextDecoder().decode(file.bytes) };
    if (!options.converter || !convertibleExtensions(options.converter).includes(kind))
      return { skip: 'unsupported_type' };
    try {
      const sha256 = createHash('sha256').update(file.bytes).digest('hex');
      const conversion = await options.converter.convert(file);
      if (isPdfFile(file) && conversion.pages.every((p) => p.trim() === ''))
        throw new NoTextLayerError(file.name);
      return {
        text: joinPages(conversion.pages),
        file: { name: file.name, sha256, pages: conversion.pages },
      };
    } catch (error) {
      if (error instanceof ConversionPending) throw error;
      return { skip: error instanceof NoTextLayerError ? 'no_text' : 'conversion_failed' };
    }
  };
  const result = await read();
  return 'text' in result && result.text.trim() === '' ? { skip: 'no_text' } : result;
};
