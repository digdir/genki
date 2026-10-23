import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import {
  defaultFetchPolicy,
  guardedFetchBytes,
  guardedFetchStream,
  huggingFaceFile,
  huggingFaceFileUrl,
  huggingFaceOrigin,
  missingColumns,
  parquetColumns,
  parquetSource,
  type GuardedFetchOptions,
  type HuggingFaceSource,
  type ParquetFile,
} from '@genai/ingest';
import type { ParquetAccess } from './index-ingestion.js';
import type { PipelineSpec } from './ingestion.js';

type ParquetSpec = Extract<PipelineSpec['source'], { kind: 'parquet' }>;
export const parquetReadTimeoutMs = 120_000;
const maxShards = 1000;

const hfUrl = (source: HuggingFaceSource, file: string) =>
  huggingFaceFileUrl({ dataset: source.dataset, revision: source.revision, file });

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
  const rows = async function* () {
    const urls = await shardUrls(source, access, fetchOptions);
    const root = access.workingDirectory ?? tmpdir();
    await mkdir(root, { recursive: true });
    let remaining = source.mapping.maxRows;
    for (const url of urls) {
      if (remaining === 0) break;
      fetchOptions.signal?.throwIfAborted();
      const directory = await mkdtemp(join(root, 'genki-parquet-'));
      try {
        const handle = await open(join(directory, 'shard.parquet'), 'wx+', 0o600);
        try {
          let size = 0;
          await guardedFetchStream(
            url,
            policyFor(access),
            source.maxBytes,
            async (chunk) => {
              // FileHandle.write may make a short write.
              let offset = 0;
              while (offset < chunk.byteLength) {
                fetchOptions.signal?.throwIfAborted();
                const { bytesWritten } = await handle.write(
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
              if (start < 0 || end < start || end > size)
                throw new Error('invalid Parquet file range');
              const buffer = new Uint8Array(end - start);
              let offset = 0;
              while (offset < buffer.byteLength) {
                fetchOptions.signal?.throwIfAborted();
                const { bytesRead } = await handle.read(
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
          const missing = missingColumns(source.mapping, await access.reader.columns(file));
          if (missing.length > 0)
            throw new Error(`the Parquet file has no column ${missing.join(', ')}`);
          for await (const row of access.reader.rows(
            file,
            parquetColumns(source.mapping),
            remaining,
          )) {
            fetchOptions.signal?.throwIfAborted();
            remaining -= 1;
            yield row;
            if (remaining === 0) break;
          }
        } finally {
          await handle.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  return parquetSource({
    rows: rows(),
    mapping: source.mapping,
    origin: parquetLocation(source).origin,
    rejectDuplicates:
      source.urls !== undefined || !!(source.huggingface && 'files' in source.huggingface),
  });
};
