import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const listed = () =>
  read('docker/recorder-files')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const covered = (path: string) =>
  listed().some((entry) => path === entry || path.startsWith(`${entry}/`));

const withoutTypeImports = (source: string) =>
  source
    .replace(/import\s+type\s*\{[^}]*\}\s*from\s*'[^']+';?/g, '')
    .replace(/import\s+type\s+\w+\s+from\s*'[^']+';?/g, '');

const packageOf = (specifier: string) =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];

const recorderReads = () => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const paths = new Set<string>(['scripts/smoke/plan.json']);
  const queue = ['scripts/demo.ts'];
  while (queue.length) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const source = withoutTypeImports(read(file));
    for (const [, specifier = ''] of source.matchAll(/from\s*'([^']+)'/g)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) queue.push(normalize(join(dirname(file), specifier)));
      else packages.add(packageOf(specifier) ?? specifier);
    }
    for (const [, target = ''] of source.matchAll(
      /new URL\('(\.\.?\/[^'$]+)', import\.meta\.url\)/g,
    ))
      paths.add(relative(root, join(root, dirname(file), target)).replace(/\/$/, ''));
  }
  return { files: [...files], packages: [...packages], paths: [...paths] };
};

describe('the recorder image', () => {
  it('ships every file the recorder imports or reads, and every package it imports', () => {
    const { files, packages, paths } = recorderReads();
    const missing = [
      ...files.filter((f) => !covered(f)),
      ...paths.filter((p) => !covered(p)),
      ...packages.map((p) => `node_modules/${p}`).filter((p) => !covered(p)),
    ];

    expect(missing).toEqual([]);
    expect(files.length).toBeGreaterThan(10);
    expect(listed()).toEqual(
      expect.arrayContaining(['package.json', 'packages/contracts/package.json']),
    );
  });

  it('lists only paths that exist, and no test file', () => {
    expect(
      listed().filter((p) => !p.startsWith('node_modules/') && !existsSync(join(root, p))),
    ).toEqual([]);
    expect(listed().filter((p) => p.endsWith('.test.ts'))).toEqual([]);
  });

  it('records the queue with Chrome and ffmpeg as the node user, voicing first', () => {
    const stage =
      read('Dockerfile').split('FROM ${NODE_IMAGE} AS recorder')[1]?.split('\nFROM ')[0] ?? '';

    expect(read('Dockerfile')).toContain('$(cat docker/recorder-files)');
    expect(stage).toContain('ffmpeg');
    expect(stage).toContain('agent-browser@0.42.0');
    expect(stage).toContain('USER node');
    expect(stage).toContain(
      'CMD ["sh", "-c", "node scripts/demo.ts queued && { node scripts/demo.ts voice --queued || true; exec node scripts/demo.ts recording --queued; }"]',
    );
  });
});
