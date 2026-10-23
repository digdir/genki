import { mkdir, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import {
  defaultFetchPolicy,
  guardedFetchBytes,
  guardedFetchStream,
  huggingFaceFile,
  huggingFaceFileUrl,
  huggingFaceOrigin,
  lookupColumns,
  missingColumns,
  parquetColumns,
  parquetLookupTable,
  parquetSource,
  type GuardedFetchOptions,
  type HuggingFaceSource,
  type ParquetFile,
  type ParquetLookup,
  type ParquetLookupTable,
} from '@genai/ingest';
import type { ParquetAccess } from './index-ingestion.js';
import type { PipelineSpec } from './ingestion.js';

type ParquetSpec = Extract<PipelineSpec['source'], { kind: 'parquet' }>;
export const parquetReadTimeoutMs = 120_000;
const maxShards = 1000;

const hfUrl = (source: HuggingFaceSource, file: string) =>
  huggingFaceFileUrl({ dataset: source.dataset, revision: source.revision, file });

// A lookup file on Hugging Face is read from the same dataset and revision as the source.
export const lookupUrl = (source: Pick<ParquetSpec, 'huggingface'>, lookup: ParquetLookup) => {
  if (lookup.url) return lookup.url;
  if (!source.huggingface || !lookup.file)
    throw new Error('a lookup file needs a huggingface source; use url otherwise');
  return hfUrl(source.huggingface, lookup.file);
};

export const parquetLocation = (
  source: Pick<ParquetSpec, 'url' | 'urls' | 'huggingface' | 'table'>,
) => {
  const hf = source.huggingface;
  if (hf && 'file' in hf) return { url: huggingFaceFileUrl(hf), origin: huggingFaceOrigin(hf) };
  if (hf) return { url: '', origin: `hf://datasets/${hf.dataset}?table=${hf.table}` };
  if (source.urls) return { url: '', origin: `parquet://tables/${source.table}` };
  return { url: source.url ?? '', origin: source.url ?? '' };
};

const policyFor = (access: ParquetAccess) => ({
  ...defaultFetchPolicy,
  readTimeoutMs: access.readTimeoutMs ?? parquetReadTimeoutMs,
  allowedHosts: new Set<string>(),
});

const shardUrls = async (source: ParquetSpec, access: ParquetAccess, web: GuardedFetchOptions) => {
  const hf = source.huggingface;
  if (!hf || 'file' in hf) return [...new Set(source.urls ?? [parquetLocation(source).url])].sort();
  if (Array.isArray(hf.files)) return [...new Set(hf.files)].sort().map((file) => hfUrl(hf, file));
  // List recursively from the glob's longest literal directory prefix.
  const prefix = hf.files.split('/');
  prefix.pop();
  const directory = prefix
    .slice(
      0,
      prefix.findIndex((s) => /[*?]/.test(s)) < 0
        ? prefix.length
        : prefix.findIndex((s) => /[*?]/.test(s)),
    )
    .join('/');
  const endpoint = `https://huggingface.co/api/datasets/${hf.dataset}/tree/${encodeURIComponent(hf.revision)}${directory ? `/${directory}` : ''}`;
  let next: string | undefined = `${endpoint}?recursive=true&limit=1000`;
  const visited = new Set<string>();
  const paths = new Set<string>();
  while (next) {
    if (visited.has(next) || visited.size >= 100)
      throw new Error('Parquet tree listing exceeds page limit');
    visited.add(next);
    const { bytes, headers } = await guardedFetchBytes(
      next,
      policyFor(access),
      5 * 1024 * 1024,
      web,
    );
    let entries: unknown;
    try {
      entries = JSON.parse(new TextDecoder().decode(bytes));
    } catch (cause) {
      throw new Error('invalid Parquet tree listing', { cause });
    }
    if (!Array.isArray(entries)) throw new Error('invalid Parquet tree listing');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') throw new Error('invalid Parquet tree listing');
      const { type, path } = entry as { type?: unknown; path?: unknown };
      if (type !== 'file') continue;
      if (typeof path !== 'string') throw new Error('invalid Parquet tree listing');
      if (!matchesGlob(path, hf.files)) continue;
      if (!huggingFaceFile.shape.file.safeParse(path).success)
        throw new Error('invalid Parquet tree listing');
      paths.add(path);
      if (paths.size > maxShards) throw new Error('Parquet table exceeds 1000 shards');
    }
    const link: string | undefined = headers
      .get('link')
      ?.split(',')
      .find((part) => /;\s*rel="?next"?/.test(part));
    const target: string | undefined = link?.match(/<([^>]+)>/)?.[1];
    if (link && !target) throw new Error('invalid Parquet tree pagination URL');
    next = target ? new URL(target, endpoint).toString() : undefined;
    // A listing can paginate only within this tree. Every request still goes
    // through the same DNS/redirect guard as a download.
    if (next) {
      const parsed = new URL(next);
      if (
        parsed.origin !== 'https://huggingface.co' ||
        parsed.pathname !== new URL(endpoint).pathname
      )
        throw new Error('invalid Parquet tree pagination URL');
    }
  }
  if (paths.size === 0) throw new Error('Parquet file pattern matched no files');
  return [...paths].sort().map((path) => hfUrl(hf, path));
};

export const parquetSourceOf = (
  access: ParquetAccess,
  source: ParquetSpec,
  web: GuardedFetchOptions = {},
) => {
  const fetchOptions = { ...web, ...(access.fetch ? { fetch: access.fetch } : {}) };
  const scratch = async () => {
    const root = access.workingDirectory ?? tmpdir();
    await mkdir(root, { recursive: true });
    return root;
  };
  // Downloads one file into a private scratch directory. dispose() closes the file and removes
  // the directory; a failed download disposes before it rethrows.
  const download = async (url: string, maxBytes: number, name: string) => {
    const directory = await mkdtemp(join(await scratch(), 'genki-parquet-'));
    let handle: FileHandle | undefined;
    const dispose = async () => {
      try {
        await handle?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    };
    try {
      const opened = await open(join(directory, name), 'wx+', 0o600);
      handle = opened;
      let size = 0;
      await guardedFetchStream(
        url,
        policyFor(access),
        maxBytes,
        async (chunk) => {
          // FileHandle.write may make a short write.
          let offset = 0;
          while (offset < chunk.byteLength) {
            fetchOptions.signal?.throwIfAborted();
            const { bytesWritten } = await opened.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              size,
            );
            if (bytesWritten === 0)
              throw new Error('Parquet temporary file write made no progress');
            offset += bytesWritten;
            size += bytesWritten;
          }
        },
        fetchOptions,
      );
      const file: ParquetFile = {
        byteLength: size,
        slice: async (start, end = size) => {
          fetchOptions.signal?.throwIfAborted();
          if (start < 0 || end < start || end > size) throw new Error('invalid Parquet file range');
          const buffer = new Uint8Array(end - start);
          let offset = 0;
          while (offset < buffer.byteLength) {
            fetchOptions.signal?.throwIfAborted();
            const { bytesRead } = await opened.read(
              buffer,
              offset,
              buffer.byteLength - offset,
              start + offset,
            );
            if (bytesRead === 0) throw new Error('unexpected end of Parquet temporary file');
            offset += bytesRead;
          }
          return buffer.buffer;
        },
      };
      return { file, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  };
  // Lookup files are read one at a time before the first shard, so only one file is on disk.
  const lookups = async () => {
    const tables: ParquetLookupTable[] = [];
    for (const lookup of source.mapping.lookups) {
      fetchOptions.signal?.throwIfAborted();
      const label = lookup.url ?? lookup.file ?? '';
      const temp = await download(lookupUrl(source, lookup), lookup.maxBytes, 'lookup.parquet');
      try {
        const known = new Set(await access.reader.columns(temp.file));
        const missing = lookupColumns(lookup).filter((c) => !known.has(c));
        if (missing.length > 0)
          throw new Error(`the Parquet lookup ${label} has no column ${missing.join(', ')}`);
        tables.push(
          await parquetLookupTable(
            access.reader.rows(temp.file, lookupColumns(lookup), lookup.maxRows + 1),
            lookup,
            label,
          ),
        );
      } finally {
        await temp.dispose();
      }
    }
    return tables;
  };
  const rows = async function* () {
    const urls = await shardUrls(source, access, fetchOptions);
    let remaining = source.mapping.maxRows;
    for (const url of urls) {
      if (remaining === 0) break;
      fetchOptions.signal?.throwIfAborted();
      const temp = await download(url, source.maxBytes, 'shard.parquet');
      try {
        const missing = missingColumns(source.mapping, await access.reader.columns(temp.file));
        if (missing.length > 0)
          throw new Error(`the Parquet file has no column ${missing.join(', ')}`);
        for await (const row of access.reader.rows(
          temp.file,
          parquetColumns(source.mapping),
          remaining,
        )) {
          fetchOptions.signal?.throwIfAborted();
          remaining -= 1;
          yield row;
          if (remaining === 0) break;
        }
      } finally {
        await temp.dispose();
      }
    }
  };
  return parquetSource({
    rows: rows(),
    mapping: source.mapping,
    origin: parquetLocation(source).origin,
    rejectDuplicates:
      source.urls !== undefined || !!(source.huggingface && 'files' in source.huggingface),
    ...(source.mapping.lookups.length > 0 ? { lookups } : {}),
  });
};
