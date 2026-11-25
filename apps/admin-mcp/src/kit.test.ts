import { link, mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const swap = vi.hoisted(() => ({ at: undefined as undefined | (() => Promise<void>) }));

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    realpath: async (path: string) => {
      const real = await fs.realpath(path);
      const run = swap.at;
      swap.at = undefined;
      await run?.();
      return real;
    },
  };
});

const { readLocalFile } = await import('./kit.js');

const folders = async () => {
  const parent = await mkdtemp(join(tmpdir(), 'genki-admin-kit-'));
  const root = join(parent, 'root');
  const outside = join(parent, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'figur.js'), 'hemmelig');
  return { root, outside };
};

afterEach(() => {
  swap.at = undefined;
});

describe('readLocalFile', () => {
  it('reads a regular file under the folder', async () => {
    const { root } = await folders();
    await writeFile(join(root, 'figur.js'), 'figur');

    const { data } = await readLocalFile('figur.js', root, 1024, 'bundlePath', '1 KiB');

    expect(data.toString()).toBe('figur');
  });

  it('refuses a hard link, since it can point at a file outside the folder', async () => {
    const { root, outside } = await folders();
    await link(join(outside, 'figur.js'), join(root, 'figur.js'));

    await expect(readLocalFile('figur.js', root, 1024, 'bundlePath', '1 KiB')).rejects.toThrow(
      /hard link/,
    );
  });

  it('refuses a file whose folder is swapped for a link out between checking and opening it', async () => {
    const { root, outside } = await folders();
    await mkdir(join(root, 'kode'));
    await writeFile(join(root, 'kode', 'figur.js'), 'figur');
    let calls = 0;
    const arm = () => {
      swap.at = async () => {
        calls += 1;
        if (calls < 2) return arm();
        await rename(join(root, 'kode'), join(root, 'gammel'));
        await symlink(outside, join(root, 'kode'));
      };
    };
    arm();

    await expect(readLocalFile('kode/figur.js', root, 1024, 'bundlePath', '1 KiB')).rejects.toThrow(
      /changed while it was read/,
    );
  });
});
