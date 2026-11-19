import { open, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  managedIdentityTokenSource,
  postgresSourceFromEnv,
  type TokenSource,
} from '@genai/providers-postgres';

// The nightly copy of the platform database and the restore drill's check (docs/runbook.md, "Backups").

export const postgresScope = 'https://ossrdbms-aad.database.windows.net/.default';
export const storageScope = 'https://storage.azure.com/.default';
const blobApiVersion = '2023-11-03';
const blockBytes = 8 * 1024 * 1024;

type Log = (msg: string, extra?: Record<string, unknown>) => void;
type Fetch = typeof fetch;

const jsonLog: Log = (msg, extra = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...extra }));

const tokenOf = async (tokens: TokenSource, scope: string) => {
  const token = await tokens(scope);
  if (!token) throw new Error(`Entra ID returned no token for ${scope}`);
  return token.token;
};

export const writePostgresToken = async (file: string, tokens: TokenSource) => {
  await writeFile(file, await tokenOf(tokens, postgresScope), { mode: 0o600 });
};

export const blobName = (now: Date) => `genai-${now.toISOString().replace(/[:.]/g, '-')}.dump`;

const blockId = (index: number) => Buffer.from(String(index).padStart(8, '0')).toString('base64');

const refuse = async (response: Response, what: string) => {
  if (response.ok) return;
  const code = response.headers.get('x-ms-error-code') ?? '';
  throw new Error(`${what} failed with ${response.status} ${code}`.trim());
};

/** Uploads in blocks, so a copy of any size fits; a name is never reused, since the container keeps every blob. */
export const uploadBackup = async (options: {
  file: string;
  containerUrl: string;
  token: string;
  now: Date;
  fetch?: Fetch;
  blockSize?: number;
}) => {
  const send = options.fetch ?? fetch;
  const blockSize = options.blockSize ?? blockBytes;
  const url = `${options.containerUrl.replace(/\/$/, '')}/${blobName(options.now)}`;
  const headers = {
    authorization: `Bearer ${options.token}`,
    'x-ms-version': blobApiVersion,
  };
  const handle = await open(options.file, 'r');
  const ids: string[] = [];
  const { size } = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  try {
    if (size === 0) throw new Error('the dump is empty');
    const buffer = Buffer.alloc(blockSize);
    for (let offset = 0; offset < size; offset += blockSize) {
      const { bytesRead } = await handle.read(buffer, 0, blockSize, offset);
      const id = blockId(ids.length);
      const response = await send(`${url}?comp=block&blockid=${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { ...headers, 'content-length': String(bytesRead) },
        body: buffer.subarray(0, bytesRead),
      });
      await refuse(response, `block ${ids.length}`);
      ids.push(id);
    }
  } finally {
    await handle.close();
  }
  const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids
    .map((id) => `<Latest>${id}</Latest>`)
    .join('')}</BlockList>`;
  const committed = await send(`${url}?comp=blocklist`, {
    method: 'PUT',
    headers: {
      ...headers,
      'content-type': 'application/xml',
      'x-ms-blob-content-type': 'application/octet-stream',
    },
    body: list,
  });
  await refuse(committed, 'the block list');
  return { blob: url.slice(url.lastIndexOf('/') + 1), bytes: size, blocks: ids.length };
};

export interface TableCount {
  table: string;
  rows: number;
}

const countTables = async (pool: pg.Pool): Promise<TableCount[]> => {
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await client.query(`select set_config('app.platform_access', 'restore-drill', true)`);
    const { rows: tables } = await client.query<{ name: string }>(
      `select format('%I.%I', schemaname, tablename) as name from pg_tables
        where schemaname in ('public', 'pgboss') order by 1`,
    );
    const counts: TableCount[] = [];
    for (const { name } of tables) {
      const { rows } = await client.query<{ n: string }>(`select count(*) as n from ${name}`);
      counts.push({ table: name, rows: Number(rows[0]?.n ?? 0) });
    }
    await client.query('commit');
    return counts;
  } finally {
    client.release();
  }
};

/** The drill's smoke test: the restored server has the source's tables, and rows in them. */
export const compareCounts = (source: TableCount[], restored: TableCount[]) => {
  const restoredBy = new Map(restored.map((count) => [count.table, count.rows]));
  const missing = source.filter((count) => !restoredBy.has(count.table)).map((c) => c.table);
  const sourceRows = source.reduce((sum, count) => sum + count.rows, 0);
  const restoredRows = restored.reduce((sum, count) => sum + count.rows, 0);
  const problems = [
    ...(missing.length > 0 ? [`tables missing on the restored server: ${missing.join(', ')}`] : []),
    ...(sourceRows > 0 && restoredRows === 0 ? ['the restored server has no rows'] : []),
  ];
  return {
    ok: problems.length === 0,
    problems,
    sourceRows,
    restoredRows,
    tables: source.map((count) => ({
      table: count.table,
      source: count.rows,
      restored: restoredBy.get(count.table) ?? null,
    })),
  };
};

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const main = async (mode: string | undefined, log: Log) => {
  const tokens = managedIdentityTokenSource(process.env.AZURE_CLIENT_ID);
  if (mode === 'token') {
    await writePostgresToken(required('PGTOKEN_FILE'), tokens);
    return;
  }
  if (mode === 'upload') {
    const started = Date.now();
    const uploaded = await uploadBackup({
      file: required('BACKUP_FILE'),
      containerUrl: required('BACKUP_CONTAINER_URL'),
      token: await tokenOf(tokens, storageScope),
      now: new Date(),
    });
    log('platform backup uploaded', {
      ...uploaded,
      seconds: Math.round((Date.now() - started) / 1000),
    });
    return;
  }
  if (mode === 'count') {
    const pool = (host: string) =>
      new pg.Pool({ ...postgresSourceFromEnv({ ...process.env, PGHOST: host }, tokens), max: 1 });
    const source = pool(required('PGHOST'));
    const restored = pool(required('DRILL_PGHOST'));
    try {
      const result = compareCounts(await countTables(source), await countTables(restored));
      log('restore drill counts', result);
      if (!result.ok) throw new Error(result.problems.join('; '));
    } finally {
      await Promise.allSettled([source.end(), restored.end()]);
    }
    return;
  }
  throw new Error(`unknown mode ${mode ?? ''}: token, upload or count`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2];
  main(mode, jsonLog).catch((error: unknown) => {
    jsonLog(mode === 'count' ? 'restore drill failed' : 'platform backup failed', {
      step: mode,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
