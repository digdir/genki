import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractTitleFromPath, findFolderFiles, makeRelativePath, toPosix } from './folder.js';

const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

describe('folder paths', () => {
  it('are written with forward slashes on a platform whose separator is a backslash', () => {
    expect(toPosix('C:\\docs\\adr\\0042.md', '\\')).toBe('C:/docs/adr/0042.md');
    expect(toPosix('docs/adr/0042.md', '/')).toBe('docs/adr/0042.md');
  });

  it('are made relative to the base with forward slashes', () => {
    expect(makeRelativePath('/repo', '/repo/docs/a.md')).toBe('/docs/a.md');
    expect(makeRelativePath(undefined, '/repo/docs/a.md')).toBe('/repo/docs/a.md');
  });

  it.runIf(process.platform === 'win32')(
    'are made relative to a base written with backslashes, as INGEST_FOLDER_ROOT is on Windows',
    () => {
      expect(makeRelativePath('C:\\repo', 'C:\\repo\\docs\\a.md')).toBe('/docs/a.md');
    },
  );

  it('list every file with forward slashes, so ids, titles and links match across machines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'folder-'));
    dirs.push(root);
    await mkdir(join(root, 'b'));
    await writeFile(join(root, 'b', 'vei-til-maal.md'), '# Vei');
    const [entry] = await findFolderFiles(root);
    expect(entry?.path.includes('\\')).toBe(false);
    expect(entry?.path.endsWith('/b/vei-til-maal.md')).toBe(true);
    expect(extractTitleFromPath(entry?.path ?? '')).toBe('Vei til maal');
  });
});
