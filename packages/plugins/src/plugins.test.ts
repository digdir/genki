import { describe, expect, it } from 'vitest';
import {
  check,
  declaredSecrets,
  manifest,
  permissionProblems,
  reachesDeclaredUrl,
  parseManifest,
  PluginRegistry,
  runContract,
  skipped,
  type ContractSuite,
} from './index.js';

const suite: ContractSuite<{ value: number }> = {
  contract: 'blob@1',
  checks: [
    { name: 'is positive', run: async (s) => check(s.value > 0, 'not positive') },
    { name: 'is even', run: async (s) => check(s.value % 2 === 0, `${s.value} is odd`) },
    { name: 'not applicable', run: async () => skipped },
  ],
};

const blobManifest = (id: string, version = '1') =>
  manifest({ kind: 'blob', id, version, contract: 'blob@1', title: id });

describe('plug-in manifests', () => {
  it('fill in defaults and refuse a contract for another kind', () => {
    expect(blobManifest('blob.memory')).toMatchObject({
      publisher: 'digdir',
      origin: 'builtin',
      capabilities: [],
      dataLocation: null,
      secrets: [],
      hosts: [],
    });
    const wrong = parseManifest({
      kind: 'blob',
      id: 'blob.x',
      version: '1',
      contract: 'model@1',
      title: 'x',
    });
    expect(wrong).toEqual({
      ok: false,
      errors: [{ path: 'contract', message: 'the contract names the kind of the plug-in' }],
    });
    expect(parseManifest({ kind: 'printer', id: 'Bad Id' }).ok).toBe(false);
  });
});

describe('contract runs', () => {
  it('report each check, and pass only when nothing failed', async () => {
    const odd = await runContract(suite, async () => ({ subject: { value: 3 } }));
    expect(odd.passed).toBe(false);
    expect(odd.results.map((r) => [r.name, r.status, r.reason])).toEqual([
      ['is positive', 'passed', undefined],
      ['is even', 'failed', '3 is odd'],
      ['not applicable', 'skipped', undefined],
    ]);
    expect((await runContract(suite, async () => ({ subject: { value: 4 } }))).passed).toBe(true);
  });

  it('fail on a setup error and on a check that hangs, and always close the target', async () => {
    const broken = await runContract(suite, async () => {
      throw new Error('no upstream');
    });
    expect(broken).toMatchObject({
      passed: false,
      results: [{ name: 'setup', status: 'failed', reason: 'no upstream' }],
    });
    let closed = false;
    const hanging = await runContract(
      { contract: 'blob@1', checks: [{ name: 'hangs', run: () => new Promise(() => undefined) }] },
      async () => ({
        subject: {},
        close: async () => {
          closed = true;
        },
      }),
      { timeoutMs: 20 },
    );
    expect(hanging.results[0]).toMatchObject({
      status: 'failed',
      reason: 'hangs did not finish within 20 ms',
    });
    expect(closed).toBe(true);
  });
});

describe('plug-in registry', () => {
  it('records runs per version and only counts the current version as the latest', async () => {
    let value = 3;
    const registry = new PluginRegistry().register({
      manifest: blobManifest('blob.memory'),
      suite,
      target: async () => ({ subject: { value } }),
    });
    expect((await registry.describe('blob.memory'))?.latest).toBeUndefined();
    const first = await registry.verify('blob.memory', { trigger: 'operator', by: 'ola' });
    expect(first).toMatchObject({ plugin: 'blob.memory', version: '1', passed: false, by: 'ola' });
    value = 4;
    await registry.verifyUnverified();
    expect((await registry.describe('blob.memory'))?.latest?.passed).toBe(false);
    await registry.verify('blob.memory', { trigger: 'operator' });
    const entry = await registry.describe('blob.memory');
    expect(entry?.latest?.passed).toBe(true);
    expect(entry?.history.map((h) => h.passed)).toEqual([false, true]);
  });

  it('refuses duplicate ids, a suite for another contract, and runs without a target', async () => {
    const registry = new PluginRegistry().register({ manifest: blobManifest('blob.ci-only') });
    expect(() => registry.register({ manifest: blobManifest('blob.ci-only') })).toThrow(
      /is registered/,
    );
    expect(() =>
      registry.register({
        manifest: blobManifest('blob.other'),
        suite: { ...suite, contract: 'blob@2' },
      }),
    ).toThrow(/brings the blob@2 suite/);
    await expect(registry.verify('blob.ci-only', { trigger: 'operator' })).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(registry.verify('finnes-ikke', { trigger: 'operator' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await registry.list())[0]).toMatchObject({ verifiable: false, history: [] });
  });
});

describe('plug-in admission', () => {
  it('runs the suite at registration without registering the plug-in, and records the run', async () => {
    const registry = new PluginRegistry();
    const run = await registry.admit(
      {
        manifest: blobManifest('blob.new'),
        suite,
        target: async () => ({ subject: { value: 3 } }),
      },
      { by: 'drift' },
    );
    expect(run).toMatchObject({ trigger: 'registration', passed: false, by: 'drift' });
    expect(registry.get('blob.new')).toBeUndefined();
    expect((await registry.runs.list('blob.new')).map((r) => r.trigger)).toEqual(['registration']);
    expect(await registry.admit({ manifest: blobManifest('blob.bare') })).toBeUndefined();
  });
});

describe('manifest permissions', () => {
  const declared = manifest({
    kind: 'model',
    id: 'model.leverandor',
    version: '1',
    contract: 'model@1',
    title: 'Leverandør',
    hosts: [
      'api.leverandor.example.no',
      '*.cdn.leverandor.example.no',
      'intern.leverandor.example.no:8443',
    ],
    secrets: ['secret://platform/leverandor-key'],
  });

  it('let a plug-in reach only the hosts and ports its manifest declares', () => {
    expect(reachesDeclaredUrl(declared, 'https://api.leverandor.example.no/v1')).toBe(true);
    expect(reachesDeclaredUrl(declared, 'https://eu.cdn.leverandor.example.no/x')).toBe(true);
    expect(reachesDeclaredUrl(declared, 'https://intern.leverandor.example.no:8443/x')).toBe(true);
    expect(reachesDeclaredUrl(declared, 'https://intern.leverandor.example.no/x')).toBe(false);
    expect(reachesDeclaredUrl(declared, 'https://evil.example.com/v1')).toBe(false);
    expect(
      permissionProblems(declared, {
        urls: [{ path: 'endpoint.baseURL', url: 'https://evil.example.com' }],
        secrets: [{ path: 'endpoint.auth.secret', ref: 'secret://platform/other' }],
      }).map((p) => p.path),
    ).toEqual(['endpoint.baseURL', 'endpoint.auth.secret']);
  });

  it('let a plug-in read only the secrets its manifest declares', async () => {
    const secrets = declaredSecrets(declared, { resolve: async (ref) => `value of ${ref}` });
    await expect(secrets.resolve('secret://platform/leverandor-key')).resolves.toBe(
      'value of secret://platform/leverandor-key',
    );
    await expect(secrets.resolve('secret://platform/database')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
