import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  blobName,
  compareCounts,
  postgresScope,
  uploadBackup,
  writePostgresToken,
} from './platform-backup.ts';

const now = new Date('2026-11-20T01:30:00Z');
const token = 'eyJ.secret-token.sig';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'platform-backup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const recorder = (status = 201) => {
  const calls: { url: string; headers: Record<string, string>; body: string | Buffer }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: Buffer.isBuffer(init.body) ? Buffer.from(init.body) : String(init.body),
    });
    return new Response(null, {
      status,
      headers: status >= 400 ? { 'x-ms-error-code': 'AuthorizationPermissionMismatch' } : {},
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};

describe('the nightly database copy', () => {
  it('names each copy by the minute it ran, so a copy is never overwritten', () => {
    expect(blobName(now)).toBe('genai-2026-11-20T01-30-00-000Z.dump');
  });

  it('uploads the dump in blocks and commits them in order', async () => {
    const file = join(dir, 'platform.dump');
    await writeFile(file, 'a'.repeat(10) + 'b'.repeat(10) + 'c'.repeat(5));
    const { calls, fetch } = recorder();
    const uploaded = await uploadBackup({
      file,
      containerUrl: 'https://genaitestbak.blob.core.windows.net/platform/',
      token,
      now,
      fetch,
      blockSize: 10,
    });
    expect(uploaded).toEqual({ blob: 'genai-2026-11-20T01-30-00-000Z.dump', bytes: 25, blocks: 3 });
    const base =
      'https://genaitestbak.blob.core.windows.net/platform/genai-2026-11-20T01-30-00-000Z.dump';
    expect(calls.map((call) => call.url)).toEqual([
      `${base}?comp=block&blockid=MDAwMDAwMDA%3D`,
      `${base}?comp=block&blockid=MDAwMDAwMDE%3D`,
      `${base}?comp=block&blockid=MDAwMDAwMDI%3D`,
      `${base}?comp=blocklist`,
    ]);
    expect(calls.slice(0, 3).map((call) => call.body.toString())).toEqual([
      'a'.repeat(10),
      'b'.repeat(10),
      'c'.repeat(5),
    ]);
    expect(calls[3]?.body).toBe(
      '<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>MDAwMDAwMDA=</Latest><Latest>MDAwMDAwMDE=</Latest><Latest>MDAwMDAwMDI=</Latest></BlockList>',
    );
  });

  it('refuses an empty dump rather than store it as a copy', async () => {
    const file = join(dir, 'platform.dump');
    await writeFile(file, '');
    const { calls, fetch } = recorder();
    await expect(
      uploadBackup({ file, containerUrl: 'https://x/platform', token, now, fetch }),
    ).rejects.toThrow('the dump is empty');
    expect(calls).toEqual([]);
  });

  it('names the status and Azure error code when a block is refused, never the token', async () => {
    const file = join(dir, 'platform.dump');
    await writeFile(file, 'data');
    const { fetch } = recorder(403);
    const failure = await uploadBackup({
      file,
      containerUrl: 'https://x/platform',
      token,
      now,
      fetch,
    }).catch((error: unknown) => error as Error);
    expect(failure.message).toBe('block 0 failed with 403 AuthorizationPermissionMismatch');
    expect(failure.message).not.toContain(token);
  });

  it('writes the Postgres token to a file only its owner can read', async () => {
    const file = join(dir, 'pgtoken');
    const scopes: string[] = [];
    await writePostgresToken(file, async (scope) => {
      scopes.push(scope);
      return { token, expiresOnTimestamp: now.getTime() + 3_600_000 };
    });
    expect(scopes).toEqual([postgresScope]);
    expect(await readFile(file, 'utf8')).toBe(token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe('the restore drill check', () => {
  it('passes when the restored server has every table of the source and rows in them', () => {
    const result = compareCounts(
      [
        { table: 'public.audit_log', rows: 120 },
        { table: 'public.services', rows: 7 },
      ],
      [
        { table: 'public.audit_log', rows: 118 },
        { table: 'public.services', rows: 7 },
      ],
    );
    expect(result.ok).toBe(true);
    expect(result.tables).toEqual([
      { table: 'public.audit_log', source: 120, restored: 118 },
      { table: 'public.services', source: 7, restored: 7 },
    ]);
  });

  it('fails when a table is missing or the restored server is empty', () => {
    expect(
      compareCounts(
        [
          { table: 'public.audit_log', rows: 120 },
          { table: 'public.services', rows: 7 },
        ],
        [{ table: 'public.audit_log', rows: 0 }],
      ).problems,
    ).toEqual([
      'tables missing on the restored server: public.services',
      'the restored server has no rows',
    ]);
  });
});
