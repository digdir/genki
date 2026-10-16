import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Chunk } from './chunk-document.js';
import { documentId } from './ids.js';
import { capitalize, javaSplit } from './text.js';

export interface FolderEntry {
  path: string;
  lastmod: string;
}

export const folderExtensions = ['.md', '.txt', '.html', '.htm'];

export const findFolderFiles = async (
  root: string,
  extensions: readonly string[] | 'all' = folderExtensions,
): Promise<FolderEntry[]> => {
  const out: FolderEntry[] = [];
  const walk = async (dir: string) => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (
        entry.isFile() &&
        (extensions === 'all' || extensions.includes(extname(entry.name).toLowerCase()))
      )
        out.push({ path: full, lastmod: String((await stat(full)).mtimeMs) });
    }
  };
  await walk(root);
  return out;
};

export const makeRelativePath = (basePath: string | undefined, path: string) =>
  basePath && path.startsWith(basePath) ? path.slice(basePath.length) : path;

export const makeFolderUrl = (
  baseUrl: string | undefined,
  relativePath: string | undefined,
  keepExtension = false,
) => {
  if (!baseUrl || !relativePath) return undefined;
  const path = keepExtension ? relativePath : relativePath.replace(/\.md$/, '');
  return `${baseUrl}${path.startsWith('/') ? path.slice(1) : path}`;
};

export const firstHeading = (markdown: string) =>
  /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1]?.trim() || undefined;

export const extractTitleFromPath = (path: string) => {
  const parts = javaSplit(path, /\//);
  const filename = (parts[parts.length - 1] ?? '').replace(/\.md$/, '');
  return capitalize(filename.replace(/-/g, ' ').replace(/_/g, ' '));
};

export const extractTitleFromFileName = (path: string) => {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return (dot > 0 ? file.slice(0, dot) : file).replace(/[-_]+/g, ' ').trim();
};

export const pathToDoc = (entry: FolderEntry) => {
  const id = documentId(entry.path);
  return {
    id,
    doc_num: id,
    path: entry.path,
    lastmod: entry.lastmod,
    title: extractTitleFromPath(entry.path),
    type: 'folder',
  };
};

const pick = (record: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.flatMap((k) => (k in record ? [[k, record[k]]] : [])));

export const prepareFolderDoc = (
  config: { basePath?: string; baseUrl?: string; keepExtension?: boolean },
  doc: Record<string, unknown>,
) => {
  const relative = makeRelativePath(config.basePath, String(doc.path));
  const url = makeFolderUrl(config.baseUrl, relative, config.keepExtension) ?? null;
  return pick({ ...doc, path: relative, url }, [
    'id',
    'doc_num',
    'title',
    'path',
    'url',
    'lastmod',
    'type',
    'total_chunks',
  ]);
};

export const prepareFolderChunks = (config: { basePath?: string }, chunks: Chunk[]) =>
  chunks.map((c) => ({
    ...pick(c as unknown as Record<string, unknown>, [
      'chunk_id',
      'doc_num',
      'chunk_index',
      'content_markdown',
      'content_length',
      'metadata',
    ]),
    id: c.chunk_id,
    path: makeRelativePath(config.basePath, c.path ?? ''),
  }));
