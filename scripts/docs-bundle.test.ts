import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docsBundleFiles, docsBundleFolder, writeDocsBundle } from './docs-bundle.ts';
import { shippedAssets } from './runtime-assets.ts';

const repo = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

describe('the GenKI docs bundle', () => {
  it('holds the repository docs a new developer starts with', () => {
    expect(docsBundleFiles()).toEqual(
      expect.arrayContaining([
        'README.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'docs/development.md',
        'docs/frontend-contract.md',
        'docs/api/README.md',
        'docs/adr/README.md',
        'docs/adr/0033-locked-test-environment.md',
        'packages/identity/README.md',
        'apps/parity/README.md',
      ]),
    );
  });

  it('takes only markdown, and nothing from node_modules or builds', () => {
    const files = docsBundleFiles();
    expect(files.filter((f) => !f.endsWith('.md'))).toEqual([]);
    expect(files.filter((f) => /(^|\/)(node_modules|dist)\//.test(f))).toEqual([]);
  });

  it('copies each file to the same path under the bundle folder', () => {
    const out = mkdtempSync(join(tmpdir(), 'docs-bundle-'));
    try {
      const files = writeDocsBundle(out);
      expect(files).toEqual(docsBundleFiles());
      expect(readFileSync(join(out, 'docs', 'development.md'), 'utf8')).toBe(
        read('docs/development.md'),
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('is built into the image at the folder root the containers read folder sources from', () => {
    expect(read('Dockerfile')).toContain(`node scripts/docs-bundle.ts /out/${docsBundleFolder}`);
    expect(read('infra/modules/containerapps.bicep')).toContain(
      `{ name: 'INGEST_FOLDER_ROOT', value: '/app/${docsBundleFolder}' }`,
    );
    expect(shippedAssets()).not.toContain(docsBundleFolder);
  });

  it('is searchable in test and prod because the database server allows the vector extension', () => {
    expect(read('infra/modules/postgres.bicep')).toMatch(
      /name: 'azure\.extensions'\s+properties: \{ value: '[A-Z_,]*VECTOR[A-Z_,]*'/,
    );
  });
});
