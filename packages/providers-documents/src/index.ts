import { extname } from 'node:path';
import {
  DocumentTooLargeError,
  NoTextLayerError,
  htmlToMarkdown,
  markerPageSeparator,
  type DocumentConverter,
  type DocumentFile,
} from '@genai/ingest';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface LocalConverterOptions {
  maxBytes?: number;
  maxUnzippedBytes?: number;
  maxPages?: number;
}

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

const pdfToMarkdown = async (file: DocumentFile, maxPages: number) => {
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
    const pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      pages.push(pageText((await page.getTextContent()).items));
      page.cleanup();
    }
    if (pages.every((p) => p === '')) throw new NoTextLayerError(file.name);
    return pages.join(markerPageSeparator);
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
    toMarkdown: async (file) => {
      if (file.bytes.byteLength > maxBytes) throw new DocumentTooLargeError(file.name, maxBytes);
      const kind = kindOf(file);
      if (kind === '.pdf') return pdfToMarkdown(file, maxPages);
      if (kind === '.docx') return docxToMarkdown(file, maxUnzippedBytes);
      if (kind === '.html' || kind === '.htm')
        return htmlToMarkdown(new TextDecoder().decode(file.bytes));
      if (kind === '.md' || kind === '.txt') return new TextDecoder().decode(file.bytes);
      throw new UnsupportedDocumentError(file.name);
    },
  };
};
