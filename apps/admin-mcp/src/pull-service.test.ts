import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, files, other, testService } from '../../api/src/testkit.js';
import { forLocal, parsePullArgs, referencesOf, runPull } from './pull-service.js';

const personToken = 'header.ola.signature';

const ola: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'ola',
  tenant: other,
  authorizedFor: [{ org: other }],
};

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: digdir,
  authorizedFor: [{ org: digdir }],
};

const withPurpose = (purpose: string) => {
  const definition = testService('hjelper', other);
  return { ...definition, spec: { ...definition.spec, purpose } };
};

const boot = async () => {
  const source = await bootPlatform({ people: { [personToken]: ola } });
  await source.platform.definitions.publish(withPurpose('Første utgave'), 'ola', 'første', files);
  await source.platform.definitions.publish(withPurpose('Andre utgave'), 'ola', 'andre', files);
  const local = await bootPlatform({ people: { 'local-dev': kari } });
  const sourceCalls: { method: string; path: string }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const { host, pathname, search } = new URL(url);
    if (host === 'api.genki-test.digdir.cloud') {
      sourceCalls.push({ method: init?.method ?? 'GET', path: pathname });
      return source.app.request(`${pathname}${search}`, init);
    }
    if (host === 'localhost:8080') return local.app.request(`${pathname}${search}`, init);
    throw new Error(`unexpected host ${host}`);
  }) as typeof globalThis.fetch;
  const pull = (argv: string[], login: { token?: string } = { token: personToken }) =>
    runPull(argv, {
      login,
      localToken: () => ({ get: async () => 'local-dev' }),
      fetch,
      now: () => new Date('2026-11-18T10:00:00Z'),
    });
  const localLatest = async () =>
    (
      (await (
        await local.send(`/tenants/${digdir}/definitions/services/hjelper`, 'local-dev')
      ).json()) as {
        latest: {
          version: number;
          definition: { metadata: { tenant: string }; spec: Record<string, unknown> };
          files: Record<string, string>;
        };
      }
    ).latest;
  return { source, local, pull, sourceCalls, localLatest };
};

describe('pulling a published service into a local genki', () => {
  it('publishes the newest published version locally, and the playground offers it', async () => {
    const { local, pull, localLatest } = await boot();

    const said = await pull(['hjelper', '--from', 'genki-test', '--tenant', other]);

    expect(said).toContain('Pulled version 2 of hjelper');
    expect(said).toContain('published it locally as version 1');
    const latest = await localLatest();
    expect(latest.definition.metadata.tenant).toBe(digdir);
    expect(latest.definition.spec.purpose).toBe('Andre utgave');
    expect(latest.files).toEqual(files);
    const options = (await (
      await local.send(`/tenants/${digdir}/playground/options`, 'local-dev')
    ).json()) as { services: { id: string; versions: { version: number }[] }[] };
    expect(options.services.find((s) => s.id === 'hjelper')?.versions).toEqual([
      expect.objectContaining({ version: 1 }),
    ]);
  });

  it('pulls the version asked for and says which one', async () => {
    const { pull, localLatest } = await boot();

    const said = await pull(['hjelper', '--tenant', other, '--version', '1']);

    expect(said).toContain('Pulled version 1 of hjelper');
    expect((await localLatest()).definition.spec.purpose).toBe('Første utgave');
  });

  it('publishes nothing and says so when that version is already the newest local version', async () => {
    const { pull, localLatest } = await boot();
    await pull(['hjelper', '--tenant', other]);

    const said = await pull(['hjelper', '--tenant', other]);

    expect(said).toContain('already the newest local version (1)');
    expect(said).toContain('nothing was published');
    expect((await localLatest()).version).toBe(1);
  });

  it('only reads from the source', async () => {
    const { pull, sourceCalls } = await boot();

    await pull(['hjelper', '--tenant', other]);

    expect(sourceCalls.length).toBeGreaterThan(0);
    expect(sourceCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('refuses to run without a login to the source, before any request', async () => {
    const { pull, sourceCalls } = await boot();

    await expect(pull(['hjelper', '--tenant', other], {})).rejects.toThrow(/log in to the source/);
    expect(sourceCalls).toEqual([]);
  });

  it('refuses an API key in place of a personal login token', async () => {
    const { pull, sourceCalls } = await boot();

    await expect(
      pull(['hjelper', '--tenant', other], { token: 'gp_shared-key-for-all' }),
    ).rejects.toThrow(/never an API key/);
    expect(sourceCalls).toEqual([]);
  });

  it("keeps the local sharing and confirms the risk class as the local person, not the source's confirmer", async () => {
    const { source, pull, localLatest } = await boot();
    const shared = withPurpose('Delt utgave');
    await source.platform.definitions.publish(
      {
        ...shared,
        spec: {
          ...shared.spec,
          riskClass: 'limited',
          riskConfirmation: { by: 'ola@source', at: '2026-11-01T10:00:00Z', reasons: ['Svarer'] },
          availableTo: ['123456789'],
        },
      },
      'ola',
      'delt',
      files,
    );

    await pull(['hjelper', '--tenant', other]);

    const { spec } = (await localLatest()).definition;
    expect(spec.availableTo).toBeUndefined();
    expect(spec.riskConfirmation).toMatchObject({ reasons: ['Svarer'] });
    expect(JSON.stringify(spec.riskConfirmation)).not.toContain('ola@source');
  });

  it('publishes nothing on a second pull of an unchanged service whose risk class needs confirming', async () => {
    const { source, pull, localLatest } = await boot();
    const confirmed = withPurpose('Bekreftet utgave');
    const published = await source.platform.definitions.publish(
      {
        ...confirmed,
        spec: {
          ...confirmed.spec,
          riskClass: 'limited',
          riskConfirmation: {
            reasons: ['Svarer'],
            riskClass: 'limited',
            by: 'ola@source',
            at: '2026-11-01T10:00:00Z',
          },
        },
      },
      'ola',
      'bekreftet',
      files,
    );
    expect(published.ok).toBe(true);
    await pull(['hjelper', '--tenant', other]);

    const said = await pull(['hjelper', '--tenant', other]);

    expect(said).toContain('nothing was published');
    expect((await localLatest()).version).toBe(1);
  });

  it('sends only the definition and its prompt files, and names the datasets, tools and skills it leaves as references', () => {
    const definition = {
      spec: {
        knowledge: { datasets: [{ dataset: 'shared/index' }] },
        tools: ['state-organisation@1', { use: 'source-facts@1' }],
        skills: ['oppsummer@1'],
      },
    };

    expect(referencesOf(definition)).toEqual({
      datasets: ['shared/index'],
      tools: ['state-organisation@1', 'source-facts@1'],
      skills: ['oppsummer@1'],
    });
    expect(Object.keys(forLocal(definition, digdir, undefined))).toEqual(['spec', 'metadata']);
  });

  it('refuses a source that is not a known name, before any login or request', async () => {
    const { pull, sourceCalls } = await boot();

    for (const from of ['https://evil.example', 'http://localhost:9999', 'toString'])
      await expect(pull(['hjelper', '--from', from, '--tenant', other])).rejects.toThrow(
        /--from must be one of: genki-test/,
      );
    expect(sourceCalls).toEqual([]);
  });

  it('never puts the login token in what it says, on success or failure', async () => {
    const { pull } = await boot();

    const said = await pull(['hjelper', '--tenant', other]);
    const failed = await pull(['hjelper', '--tenant', other, '--version', '9']).catch(
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(failed).toMatch(/HTTP 404/);
    expect(said).not.toContain(personToken);
    expect(failed).not.toContain(personToken);
  });

  it('refuses a target that is not on this machine', () => {
    expect(() => parsePullArgs(['hjelper', '--to', 'https://api.genki-test.digdir.cloud'])).toThrow(
      /on this machine/,
    );
  });

  it('refuses a service id that is not a plain id', () => {
    expect(() => parsePullArgs(['../operator'])).toThrow(/not a valid id/);
  });
});
