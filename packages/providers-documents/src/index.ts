import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import {
  DocumentTooLargeError,
  htmlToMarkdown,
  onePage,
  textLayer,
  type DocumentConverter,
  type DocumentFile,
} from '@genai/ingest';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** A PDF page the text layer could not read, named by the file's sha256 and the page, counted from 1. */
export interface UnreadablePage {
  sha256: string;
  page: number;
  error: string;
}

export interface LocalConverterOptions {
  maxBytes?: number;
  maxUnzippedBytes?: number;
  maxPages?: number;
  /** Told of each PDF page left empty because it could not be read. */
  onUnreadablePage?: (page: UnreadablePage) => void;
}

/**
 * Reads pages 1 to `count`: a page that cannot be read is left empty and reported, and the rest are
 * kept; a file none of whose pages can be read fails with the first page's error.
 */
export const readEachPage = async (
  count: number,
  read: (page: number) => Promise<string>,
  unreadable: (page: number, error: unknown) => void = () => undefined,
): Promise<string[]> => {
  const pages: string[] = [];
  const failed: { page: number; error: unknown }[] = [];
  for (let n = 1; n <= count; n += 1) {
    try {
      pages.push(await read(n));
    } catch (error) {
      failed.push({ page: n, error });
      pages.push('');
    }
  }
  if (count > 0 && failed.length === count) throw failed[0]?.error;
  for (const { page, error } of failed) unreadable(page, error);
  return pages;
};

// The parse errors pdf.js raises for a broken object; a page it cannot read can leave one unhandled.
const pdfParseErrors = new Set(['FormatError', 'UnknownErrorException', 'InvalidPDFException']);

/** Whether an unhandled rejection is a parse error pdf.js left behind for a page it could not read. */
export const isPdfParseLeak = (reason: unknown): boolean =>
  typeof reason === 'object' &&
  reason !== null &&
  pdfParseErrors.has(String((reason as { name?: unknown }).name));

/**
 * Keeps the process alive when pdf.js leaves a page's parse error unhandled: the page has already
 * failed and been left empty. Any other unhandled rejection is thrown again, so it still ends the
 * process as it would without a handler.
 */
export const guardPdfParseLeaks = (
  log: (msg: string, fields: Record<string, unknown>) => void,
  target: Pick<NodeJS.Process, 'on'> = process,
) => {
  target.on('unhandledRejection', (reason) => {
    if (!isPdfParseLeak(reason)) throw reason;
    const { name, message } = reason as Error;
    log('pdf.js left a parse error unhandled', { error: `${name}: ${message}` });
  });
};

export const localConverterExtensions = ['.pdf', '.docx', '.md', '.txt', '.html', '.htm'];

export class UnsupportedDocumentError extends Error {
  override readonly name = 'UnsupportedDocumentError';
  constructor(document: string) {
    super(`${document} is not a type the local converter reads`);
  }
}

export class TooManyPagesError extends Error {
  override readonly name = 'TooManyPagesError';
  constructor(document: string, maxPages: number) {
    super(`${document} has more than ${maxPages} pages`);
  }
}

export const declaredUnzippedBytes = (zip: Uint8Array) => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.byteLength - 22;
  const floor = Math.max(0, end - 0xffff);
  while (end >= floor && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < floor) return undefined;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > zip.byteLength || view.getUint32(at, true) !== 0x02014b50) return undefined;
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) return Infinity;
    total += size;
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return total;
};

const mimeKinds: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

const kindOf = (file: DocumentFile) => {
  const ext = extname(file.name).toLowerCase();
  if (localConverterExtensions.includes(ext)) return ext;
  return mimeKinds[(file.mimetype ?? '').split(';')[0]?.trim().toLowerCase() ?? ''];
};

interface TextItem {
  str: string;
  hasEOL: boolean;
  transform: number[];
  height: number;
}

const isTextItem = (item: object): item is TextItem => 'str' in item;

const pageText = (items: object[]) => {
  let out = '';
  let lastY: number | undefined;
  let lastHeight = 0;
  for (const item of items.filter(isTextItem)) {
    const y = item.transform[5] as number;
    if (lastY !== undefined && out.endsWith('\n') && lastY - y > Math.max(lastHeight, 1) * 1.6)
      out += '\n';
    out += item.str;
    if (item.hasEOL) out += '\n';
    if (item.str !== '') {
      lastY = y;
      lastHeight = item.height;
    }
  }
  return out
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

/** One markdown string per PDF page; a page with no text layer is empty. */
const pdfPages = async (
  file: DocumentFile,
  maxPages: number,
  onUnreadablePage?: (page: UnreadablePage) => void,
) => {
  const task = getDocument({
    data: new Uint8Array(file.bytes),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > maxPages) throw new TooManyPagesError(file.name, maxPages);
    return await readEachPage(
      pdf.numPages,
      async (n) => {
        const page = await pdf.getPage(n);
        try {
          return pageText((await page.getTextContent()).items);
        } finally {
          page.cleanup();
        }
      },
      (page, error) =>
        onUnreadablePage?.({
          sha256: createHash('sha256').update(file.bytes).digest('hex'),
          page,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
    );
  } finally {
    await task.destroy();
  }
};

const docxToMarkdown = async (file: DocumentFile, maxUnzippedBytes: number) => {
  const unzipped = declaredUnzippedBytes(file.bytes);
  if (unzipped !== undefined && unzipped > maxUnzippedBytes)
    throw new DocumentTooLargeError(file.name, maxUnzippedBytes);
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(file.bytes) },
    {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    },
  );
  return htmlToMarkdown(result.value);
};

export const createLocalConverter = (options: LocalConverterOptions = {}): DocumentConverter => {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const maxUnzippedBytes = options.maxUnzippedBytes ?? 200 * 1024 * 1024;
  const maxPages = options.maxPages ?? 2000;
  return {
    extensions: localConverterExtensions,
    convert: async (file) => {
      if (file.bytes.byteLength > maxBytes) throw new DocumentTooLargeError(file.name, maxBytes);
      const kind = kindOf(file);
      if (kind === '.pdf')
        return {
          pages: await pdfPages(file, maxPages, options.onUnreadablePage),
          converter: textLayer,
        };
      if (kind === '.docx') return onePage(await docxToMarkdown(file, maxUnzippedBytes));
      if (kind === '.html' || kind === '.htm')
        return onePage(htmlToMarkdown(new TextDecoder().decode(file.bytes)));
      if (kind === '.md' || kind === '.txt') return onePage(new TextDecoder().decode(file.bytes));
      throw new UnsupportedDocumentError(file.name);
    },
  };
};
