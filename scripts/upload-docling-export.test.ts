import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryNativeOutputContainer, nativeOutputStore, settingsHash } from '@genai/port-blob';
import {
  doclingKey,
  doclingSettings,
  listExport,
  parseCount,
  upload,
} from './upload-docling-export.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const exportOf = async (shas: string[]) => {
  const root = await mkdtemp(join(tmpdir(), 'docling-export-'));
  roots.push(root);
  for (const sha256 of shas) {
    const dir = join(root, sha256.slice(0, 2), sha256);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'docling.json'), '{"schema_name":"DoclingDocument"}');
    await writeFile(
      join(dir, 'done.json'),
      JSON.stringify({
        sha256,
        tool: 'docling',
        tool_version: '2.123.1',
        pages: 3,
        finished_at: '2026-08-28T17:47:10Z',
        files: ['docling.json'],
        hostname: 'bigbox',
        models: { pipeline: 'standard', ocr: 'easyocr langs=no,en', tableformer: 'ACCURATE' },
      }),
    );
  }
  return root;
};

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);

describe('upload-docling-export', () => {
  it("the Docling export's settings hash is b48834151e40e32998687534cdd32f6cfce37fe3672d96f76c235f50fdff3f6f", () => {
    expect(settingsHash(doclingSettings)).toBe(
      'b48834151e40e32998687534cdd32f6cfce37fe3672d96f76c235f50fdff3f6f',
    );
  });

  it('a file whose output is already in the container is skipped', async () => {
    const root = await exportOf([a, b]);
    const container = new InMemoryNativeOutputContainer();
    await nativeOutputStore(container).put(doclingKey(a), new TextEncoder().encode('{}'), 1);
    const { counts } = await upload({ dirs: await listExport(root), container, concurrency: 2 });
    expect(counts).toMatchObject({ found: 2, alreadyThere: 1, uploaded: 1, failed: 0 });
    expect((await container.list(`${a}/`)).length).toBe(2);
    expect((await container.list(`${b}/`)).length).toBe(2);
  });

  it('a dry run with a container uploads nothing', async () => {
    const root = await exportOf([a, b]);
    const container = new InMemoryNativeOutputContainer();
    const { counts } = await upload({
      dirs: await listExport(root),
      container,
      dryRun: true,
      concurrency: 2,
    });
    expect(counts).toMatchObject({ checked: 2, uploaded: 0 });
    expect(container.blobs.size).toBe(0);
  });

  it('a stray file in the export folder is ignored', async () => {
    const root = await exportOf([a]);
    await writeFile(join(root, '.DS_Store'), '');
    await writeFile(join(root, 'aa', '.DS_Store'), '');
    expect((await listExport(root)).map((d) => d.sha256)).toEqual([a]);
  });

  it('a concurrency or limit that is not a positive whole number is refused', () => {
    expect(parseCount('16', '--concurrency')).toBe(16);
    for (const bad of ['x', '0', '-1', '2.5', ''])
      expect(() => parseCount(bad, '--concurrency')).toThrow(/--concurrency/);
  });
});
