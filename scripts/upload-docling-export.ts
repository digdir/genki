import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DefaultAzureCredential } from '@azure/identity';
import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { nativeOutputEntry, nativeOutputStore, type NativeOutputKey } from '@genai/port-blob';
import { AzureNativeOutputContainer } from '@genai/providers-azure-blob';

// Copies a Docling export (<prefix>/<sha256>/docling.json + done.json) to the native output container; only reads the export.
const usage = `npx tsx --conditions=source scripts/upload-docling-export.ts --url <container URL> [--root <dir>] [--auth login|key] [--limit <n>] [--concurrency <n>] [--dry-run]

--auth login uses your az login (needs Storage Blob Data Contributor on the container); --auth key reads AZURE_STORAGE_KEY.
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

const listExport = async (root: string) => {
  const dirs: { sha256: string; dir: string }[] = [];
  for (const prefix of (await readdir(root)).sort())
    for (const sha256 of (await readdir(join(root, prefix))).sort())
      if (sha256Pattern.test(sha256)) dirs.push({ sha256, dir: join(root, prefix, sha256) });
  return dirs;
};

const containerFor = (url: string, auth: string) => {
  if (auth === 'key') {
    const key = process.env.AZURE_STORAGE_KEY;
    if (!key) throw new Error('--auth key needs AZURE_STORAGE_KEY');
    const account = new URL(url).hostname.split('.')[0] ?? '';
    return new ContainerClient(url, new StorageSharedKeyCredential(account, key));
  }
  return new ContainerClient(url, new DefaultAzureCredential());
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

const main = async () => {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      root: { type: 'string', default: join(homedir(), 'kudos-docling', 'json', 'docling') },
      auth: { type: 'string', default: 'login' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '16' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || (!values.url && !values['dry-run'])) {
    console.log(usage);
    process.exit(values.help ? 0 : 1);
  }
  const started = Date.now();
  const dirs = await listExport(values.root);
  const key = (sha256: string): NativeOutputKey => ({
    sha256,
    converter: 'docling',
    version: doclingVersion,
    settings: doclingSettings,
  });

  const container = values.url
    ? new AzureNativeOutputContainer(containerFor(values.url, values.auth))
    : undefined;
  const there = new Set(container ? await container.list('') : []);
  const todo = dirs.filter(({ sha256 }) => !there.has(nativeOutputEntry(key(sha256)).path));
  const limit = values.limit ? Number(values.limit) : todo.length;
  const queue = todo.slice(0, limit);
  const store = container && nativeOutputStore(container);

  const counts = {
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
  const report = () =>
    console.log(JSON.stringify({ ...counts, seconds: Math.round((Date.now() - started) / 1000) }));
  const ticker = setInterval(report, 30_000);

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
          store.put(key(sha256), output, done.pages, done.finished_at),
        );
        counts.gzipBytes += entry.bytes;
        counts.uploaded += 1;
      } catch (error) {
        counts.failed += 1;
        problems.push(`${sha256}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, work));
  clearInterval(ticker);
  report();
  for (const p of problems.slice(0, 50)) console.error(p);
  if (problems.length > 50) console.error(`... and ${problems.length - 50} more`);
  if (counts.failed) process.exit(1);
};

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
