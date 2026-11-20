import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

const root = join(import.meta.dirname, '..');

/** Every service genki seeds or ships as an example to copy. */
const serviceFolders = [
  'apps/api/config/local/services',
  'apps/parity/config/services',
  'packages/strategy-step-flow/examples/services',
];
const serviceFiles = [
  'packages/definitions/examples/kunnskapsassistenten.yaml',
  'scripts/smoke/smoke-service.yaml',
];

const seeded = () => [
  ...serviceFolders.flatMap((folder) =>
    readdirSync(join(root, folder))
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => `${folder}/${file}`),
  ),
  ...serviceFiles,
];

const rerankerOf = (file: string) =>
  parseAllDocuments(readFileSync(join(root, file), 'utf8')).map(
    (doc) =>
      (doc.toJS() as { spec?: { knowledge?: { reranker?: string } } } | null)?.spec?.knowledge
        ?.reranker,
  );

describe('seeded services', () => {
  it('no seeded service names a reranker', () => {
    expect(seeded().length).toBeGreaterThan(10);
    const naming = seeded().flatMap((file) =>
      rerankerOf(file).flatMap((reranker) =>
        reranker === undefined ? [] : [`${file}: ${reranker}`],
      ),
    );
    expect(naming).toEqual([]);
  });
});
