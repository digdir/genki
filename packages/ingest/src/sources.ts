import { readFile } from 'node:fs/promises';
import type { BlobStore } from '@genai/port-blob';
import type { Chunk } from './chunk-document.js';
import { NoTextLayerError, type DocumentConverter } from './converter.js';
import { readDocument, skipReasonFor, type ReadDocument } from './documents.js';
import {
  extractTitleFromFileName,
  headingTitle,
  makeRelativePath,
  pathToDoc,
  prepareFolderChunks,
  prepareFolderDoc,
  type FolderEntry,
} from './folder.js';
import type { ContentExtractor, WebPage } from './html.js';
import { documentId } from './ids.js';
import {
  FileUnreachable,
  fillInKudosFields,
  prepareKudosChunks,
  kudosPublicUrl,
  prepareKudosDoc,
  type KudosDocument,
  type KudosFile,
  type KudosProfile,
} from './kudos.js';
import type { IngestSource, SkipReason, SourceDocument } from './pipeline.js';
import {
  mergeFrontmatter,
  prepareWebsiteChunks,
  prepareWebsiteDoc,
  urlToDoc,
  type FetchedBody,
  type SitemapEntry,
} from './website.js';

export interface KudosSourceOptions {
  documents: AsyncIterable<KudosDocument> | Iterable<KudosDocument>;
  fetchFile(file: KudosFile): Promise<Uint8Array>;
  converter: DocumentConverter;
  types?: Set<string>;
  profile?: KudosProfile;
}

const kudosTexts = async (
  options: KudosSourceOptions,
  doc: ReturnType<typeof fillInKudosFields>,
): Promise<{ texts: string[]; skip?: SkipReason }> => {
  const files: { file: KudosFile; bytes: Uint8Array }[] = [];
  try {
    for (const file of doc.files ?? []) files.push({ file, bytes: await options.fetchFile(file) });
  } catch (error) {
    if (error instanceof FileUnreachable) return { texts: [], skip: 'unreachable' };
    throw error;
  }
  const texts: string[] = [];
  let skip: SkipReason | undefined;
  for (const { file, bytes } of files) {
    try {
      const text = await options.converter.toMarkdown({
        name: file.url.split('/').pop() ?? `${doc.id}.pdf`,
        bytes,
        ...(file.mimetype ? { mimetype: file.mimetype } : {}),
      });
      if (text.trim() === '') skip = 'no_text';
      else texts.push(text);
    } catch (error) {
      skip = error instanceof NoTextLayerError ? 'no_text' : 'conversion_failed';
    }
  }
  return texts.length === 0 && skip ? { texts, skip } : { texts };
};

export const kudosSource = (options: KudosSourceOptions): IngestSource => ({
  kind: 'kudos',
  phraseRows: 'legacy',
  documents: async function* () {
    const seen = new Set<string>();
    for await (const raw of options.documents) {
      if (options.types && !options.types.has(String(raw.type))) continue;
      const doc = fillInKudosFields(raw);
      if (seen.has(doc.id)) continue;
      seen.add(doc.id);
      const listed: SourceDocument = {
        key: doc.id,
        docNum: doc.doc_num,
        texts: [],
        url: kudosPublicUrl(doc.id, options.profile),
        stored: (chunks: Chunk[]) => prepareKudosDoc(doc, chunks.length),
        storedChunks: (chunks: Chunk[]) => prepareKudosChunks(chunks),
      };
      yield {
        ...listed,
        prepare: async () => {
          const read = await kudosTexts(options, doc);
          return {
            ...listed,
            texts: read.texts,
            ...(read.skip ? { name: doc.title ?? doc.id, skip: read.skip } : {}),
          };
        },
      };
    }
  },
});

export interface WebsiteSourceOptions {
  entries: SitemapEntry[];
  baseUrl?: string;
  fetchMarkdown?(entry: SitemapEntry): Promise<string | WebPage>;
  fetchBody?(entry: SitemapEntry): Promise<FetchedBody>;
  converter?: DocumentConverter;
  extract?: ContentExtractor;
}

const readWebsiteEntry = async (
  options: WebsiteSourceOptions,
  entry: SitemapEntry,
): Promise<ReadDocument> => {
  if (options.fetchBody) {
    const body = await options.fetchBody(entry);
    return readDocument(
      {
        name: new URL(entry.loc).pathname,
        bytes: body.bytes,
        ...(body.contentType ? { mimetype: body.contentType } : {}),
      },
      {
        defaultExtension: '.html',
        ...(options.converter ? { converter: options.converter } : {}),
        ...(options.extract ? { extract: options.extract } : {}),
      },
    );
  }
  if (!options.fetchMarkdown) throw new Error('a website source needs fetchBody or fetchMarkdown');
  const fetched = await options.fetchMarkdown(entry);
  const page = typeof fetched === 'string' ? { markdown: fetched } : fetched;
  return page.markdown.trim() === ''
    ? { skip: 'no_text' }
    : { text: page.markdown, ...(page.title ? { title: page.title } : {}) };
};

export const websiteSource = (options: WebsiteSourceOptions): IngestSource => ({
  kind: 'website',
  phraseRows: 'pipeline',
  documents: async function* () {
    for (const entry of options.entries) {
      const read = await readWebsiteEntry(options, entry);
      const markdown = 'text' in read ? read.text : '';
      const merged = mergeFrontmatter(urlToDoc(entry), markdown);
      const doc = 'title' in read && read.title ? { ...merged, title: read.title } : merged;
      yield {
        key: doc.id,
        docNum: doc.doc_num,
        name: entry.loc,
        ...('skip' in read ? { skip: read.skip } : {}),
        texts: [markdown],
        location: { key: 'url', value: entry.loc },
        stored: (chunks: Chunk[]) =>
          prepareWebsiteDoc(options.baseUrl, { ...doc, total_chunks: chunks.length }),
        storedChunks: (chunks: Chunk[]) => prepareWebsiteChunks(options.baseUrl, chunks),
      };
    }
  },
});

export interface FolderSourceOptions {
  entries: FolderEntry[];
  basePath?: string;
  baseUrl?: string;
  keepExtension?: boolean;
  titleFrom?: 'file-name' | 'heading';
  extensions?: readonly string[];
  read?(path: string): Promise<string>;
  readBytes?(path: string): Promise<Uint8Array>;
  converter?: DocumentConverter;
}

const readFolderEntry = async (
  options: FolderSourceOptions,
  path: string,
): Promise<ReadDocument> => {
  if (options.read) {
    const text = await options.read(path);
    return text.trim() === '' ? { skip: 'no_text' } : { text };
  }
  const skip = skipReasonFor(path, options.converter, options.extensions);
  if (skip) return { skip };
  return readDocument(
    { name: path, bytes: await (options.readBytes ?? readFile)(path) },
    {
      ...(options.converter ? { converter: options.converter } : {}),
      ...(options.extensions ? { textExtensions: options.extensions } : {}),
    },
  );
};

export const folderSource = (options: FolderSourceOptions): IngestSource => ({
  kind: 'folder',
  phraseRows: 'pipeline',
  documents: async function* () {
    for (const entry of options.entries) {
      const read = await readFolderEntry(options, entry.path);
      const heading =
        options.titleFrom === 'heading' && 'text' in read
          ? headingTitle(entry.path, read.text)
          : undefined;
      const doc = { ...pathToDoc(entry), ...(heading ? { title: heading } : {}) };
      const config = {
        ...(options.basePath ? { basePath: options.basePath } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        ...(options.keepExtension ? { keepExtension: true } : {}),
      };
      yield {
        key: doc.id,
        docNum: doc.doc_num,
        name: makeRelativePath(options.basePath, entry.path),
        ...('skip' in read ? { skip: read.skip } : {}),
        texts: ['text' in read ? read.text : ''],
        location: { key: 'path', value: entry.path },
        stored: (chunks: Chunk[]) =>
          prepareFolderDoc(config, { ...doc, total_chunks: chunks.length }),
        storedChunks: (chunks: Chunk[]) => prepareFolderChunks(config, chunks),
      };
    }
  },
});

export interface UploadSourceOptions {
  blobs: Pick<BlobStore, 'list' | 'get'>;
  tenant: string;
  prefix: string;
  converter?: DocumentConverter;
}

export const uploadDocumentId = (tenant: string, path: string) =>
  documentId(`blob://${tenant}/${path}`);

export const uploadSource = (options: UploadSourceOptions): IngestSource => ({
  kind: 'upload',
  phraseRows: 'pipeline',
  documents: async function* () {
    for (const info of await options.blobs.list(options.tenant, options.prefix)) {
      const name = info.path.slice(options.prefix.length);
      const id = uploadDocumentId(options.tenant, info.path);
      const skip = skipReasonFor(name, options.converter);
      const blob = skip ? undefined : await options.blobs.get(info);
      if (!skip && !blob) continue;
      const read: ReadDocument =
        skip || !blob
          ? { skip: skip ?? 'no_text' }
          : await readDocument(
              { name, bytes: blob.body, mimetype: info.contentType },
              options.converter ? { converter: options.converter } : {},
            );
      const doc = {
        id,
        doc_num: id,
        title: extractTitleFromFileName(name),
        path: name,
        lastmod: info.createdAt,
        sha256: info.sha256,
        type: 'upload',
      };
      yield {
        key: id,
        docNum: id,
        name,
        ...('skip' in read ? { skip: read.skip } : {}),
        texts: ['text' in read ? read.text : ''],
        location: { key: 'path', value: name },
        stored: (chunks: Chunk[]) => ({ ...doc, total_chunks: chunks.length }),
        storedChunks: (chunks: Chunk[]) =>
          chunks.map((c) => ({
            id: c.chunk_id,
            chunk_id: c.chunk_id,
            doc_num: c.doc_num,
            chunk_index: c.chunk_index,
            content_markdown: c.content_markdown,
            content_length: c.content_length,
            metadata: c.metadata,
            path: name,
          })),
      };
    }
  },
});
