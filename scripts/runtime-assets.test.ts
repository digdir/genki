import { describe, expect, it } from 'vitest';
import {
  assetExists,
  codeRelativePaths,
  dockerfile,
  runtimeAssetReads,
  runtimeWorkspaces,
  shippedAssets,
} from './runtime-assets.ts';

const covered = (path: string) =>
  shippedAssets().some((asset) => path === asset || path.startsWith(`${asset}/`));

describe('runtime assets in the image', () => {
  it('ship every folder the api and worker read relative to their code', () => {
    const missing = runtimeAssetReads().filter((read) => !covered(read.path));
    expect(missing.map((m) => `${m.file} reads ${m.path}`)).toEqual([]);
  });

  it('are found for the reads that once broke genki-test', () => {
    const paths = runtimeAssetReads().map((read) => read.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'packages/eval/judges',
        'packages/eval/testsets',
        'apps/parity/config/services',
        'packages/jobs/examples',
        'apps/api/config/local',
      ]),
    );
  });

  it('list only folders that exist', () => {
    expect(shippedAssets().filter((asset) => !assetExists(asset))).toEqual([]);
  });

  it('are copied by the Dockerfile from docker/runtime-assets', () => {
    expect(dockerfile()).toContain('$(cat docker/runtime-assets)');
  });

  it('follow the dependencies of the api and worker', () => {
    expect(runtimeWorkspaces()).toEqual(
      expect.arrayContaining(['apps/api', 'apps/worker', 'packages/eval', 'packages/jobs']),
    );
  });

  it('resolve joins on import.meta.dirname and on names bound to one', () => {
    const source = [
      "const a = join(import.meta.dirname, '..', 'judges', `${id}.yaml`);",
      "const root = join(import.meta.dirname, '..', '..', '..');",
      "const b = join(root, 'packages', 'jobs', 'examples');",
      "const c = join(\n  import.meta.dirname,\n  '..',\n  'testsets',\n);",
    ].join('\n');
    expect(codeRelativePaths(source, '/r/packages/eval/src')).toEqual([
      '/r/packages/eval/judges',
      '/r',
      '/r/packages/eval/testsets',
      '/r/packages/jobs/examples',
    ]);
  });
});
