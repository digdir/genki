import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { AzureCliCredential } from '@azure/identity';
import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import {
  nativeOutputEntry,
  nativeOutputStore,
  type NativeOutputContainer,
  type NativeOutputKey,
} from '@genai/port-blob';
import { AzureNativeOutputContainer } from '@genai/providers-azure-blob';

// Copies a Docling export (<prefix>/<sha256>/docling.json + done.json) to the native output container; only reads the export.
const usage = `npx tsx --conditions=source scripts/upload-docling-export.ts --root <export dir> --url <container URL> [--auth login|key] [--limit <n>] [--concurrency <n>] [--dry-run]

--auth login uses your az login (AzureCliCredential) (needs Storage Blob Data Contributor on the container); --auth key reads AZURE_STORAGE_KEY.
--limit uploads at most n files not yet in the container. Files already there are skipped, so a run can be repeated.`;

export const doclingVersion = '2.123.1';
export const doclingSettings = {
  pipeline: 'standard',
  ocr: 'easyocr',
  languages: ['no', 'en'],
  tableformer: 'accurate',
};

interface Done {
  sha256: string;
  tool: string;
  tool_version: string;
  pages: number;
  finished_at: string;
  files: string[];
  models: { pipeline: string; ocr: string; tableformer: string };
}

const sha256Pattern = /^[0-9a-f]{64}$/;

export const checkDone = (sha256: string, done: Done): string | undefined => {
  if (done.sha256 !== sha256) return `done.json names ${done.sha256}`;
  if (done.tool !== 'docling' || done.tool_version !== doclingVersion)
    return `tool ${done.tool} ${done.tool_version}`;
  const m = done.models;
  if (
    m.pipeline !== 'standard' ||
    m.ocr !== 'easyocr langs=no,en' ||
    m.tableformer.toLowerCase() !== 'accurate'
  )
    return `models ${JSON.stringify(m)}`;
  if (!Number.isInteger(done.pages) || done.pages < 0) return `pages ${done.pages}`;
  if (Number.isNaN(Date.parse(done.finished_at))) return `finished_at ${done.finished_at}`;
  if (!done.files.includes('docling.json')) return 'no docling.json in done.json';
  return undefined;
};

export const doclingKey = (sha256: string): NativeOutputKey => ({
  sha256,
  converter: 'docling',
  version: doclingVersion,
  settings: doclingSettings,
});

export interface ExportDir {
  sha256: string;
  dir: string;
}

export const listExport = async (root: string): Promise<ExportDir[]> => {
  const dirs: ExportDir[] = [];
  const folders = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  for (const prefix of await folders(root))
    for (const sha256 of await folders(join(root, prefix)))
      if (sha256Pattern.test(sha256)) dirs.push({ sha256, dir: join(root, prefix, sha256) });
  return dirs;
};

export const parseCount = (value: string, name: string) => {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a whole number above 0, not "${value}"`);
  return n;
};

const containerFor = (url: string, auth: string) => {
  if (auth === 'key') {
    const key = process.env.AZURE_STORAGE_KEY;
    if (!key) throw new Error('--auth key needs AZURE_STORAGE_KEY');
    const account = new URL(url).hostname.split('.')[0] ?? '';
    return new ContainerClient(url, new StorageSharedKeyCredential(account, key));
  }
  return new ContainerClient(url, new AzureCliCredential());
};

const retry = async <T>(run: () => Promise<T>, tries = 4): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= tries) throw error;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
};

export interface UploadOptions {
  dirs: ExportDir[];
  container?: NativeOutputContainer;
  dryRun?: boolean;
  limit?: number;
  concurrency: number;
  onProgress?: (counts: Counts) => void;
}

export interface Counts {
  found: number;
  alreadyThere: number;
  uploaded: number;
  checked: number;
  mismatched: number;
  failed: number;
  rawBytes: number;
  gzipBytes: number;
}

export const upload = async ({
  dirs,
  container,
  dryRun = false,
  limit,
  concurrency,
  onProgress,
}: UploadOptions) => {
  const there = new Set(container ? await container.list('') : []);
  const todo = dirs.filter(({ sha256 }) => !there.has(nativeOutputEntry(doclingKey(sha256)).path));
  const queue = todo.slice(0, limit ?? todo.length);
  const store = container && !dryRun ? nativeOutputStore(container) : undefined;
  const counts: Counts = {
    found: dirs.length,
    alreadyThere: dirs.length - todo.length,
    uploaded: 0,
    checked: 0,
    mismatched: 0,
    failed: 0,
    rawBytes: 0,
    gzipBytes: 0,
  };
  const problems: string[] = [];
  const ticker = onProgress && setInterval(() => onProgress(counts), 30_000);

  let next = 0;
  const work = async () => {
    for (let item = queue[next++]; item; item = queue[next++]) {
      const { sha256, dir } = item;
      try {
        const done = JSON.parse(await readFile(join(dir, 'done.json'), 'utf8')) as Done;
        const wrong = checkDone(sha256, done);
        if (wrong) {
          counts.mismatched += 1;
          problems.push(`${sha256}: ${wrong}`);
          continue;
        }
        const output = new Uint8Array(await readFile(join(dir, 'docling.json')));
        counts.rawBytes += output.byteLength;
        if (!store) {
          counts.checked += 1;
          continue;
        }
        const entry = await retry(() =>
          store.put(doclingKey(sha256), output, done.pages, done.finished_at),
        );
        counts.gzipBytes += entry.bytes;
        counts.uploaded += 1;
      } catch (error) {
        counts.failed += 1;
        problems.push(`${sha256}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, work));
  } finally {
    if (ticker) clearInterval(ticker);
  }
  return { counts, problems };
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      root: { type: 'string' },
      auth: { type: 'string', default: 'login' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '16' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.root || (!values.url && !values['dry-run'])) {
    console.log(usage);
    process.exit(values.help ? 0 : 1);
  }
  const started = Date.now();
  const report = (counts: Counts) =>
    console.log(JSON.stringify({ ...counts, seconds: Math.round((Date.now() - started) / 1000) }));
  const { counts, problems } = await upload({
    dirs: await listExport(values.root ?? ''),
    container: values.url
      ? new AzureNativeOutputContainer(containerFor(values.url, values.auth))
      : undefined,
    dryRun: values['dry-run'],
    limit: values.limit === undefined ? undefined : parseCount(values.limit, '--limit'),
    concurrency: parseCount(values.concurrency, '--concurrency'),
    onProgress: report,
  });
  report(counts);
  for (const p of problems.slice(0, 50)) console.error(p);
  if (problems.length > 50) console.error(`... and ${problems.length - 50} more`);
  if (counts.failed) process.exit(1);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
