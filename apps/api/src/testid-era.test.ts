import { triggerId, triggerPauseKind } from '@genai/jobs';
import { describe, expect, it } from 'vitest';
import { InMemoryAdminRecords } from './admin.js';
import { appendVersion, InMemoryConfigEntryStore } from './config-store.js';
import { maskinportenClientKind } from './maskinporten-clients.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import {
  forgetsTestIdEraRevocation,
  forgetTestIdEraRevocation,
  productionAnsattporten,
  revokesTestIdEra,
  revokeTestIdEra,
  testIdEraReason,
  type TestIdEraDeps,
} from './testid-era.js';

const DIGDIR = '312521172';
const SYNTHETIC = '310000001';
let clock = Date.parse('2026-11-26T10:00:00Z');
const now = () => new Date((clock += 1000));
const nightly = { kind: 'schedule' as const, cron: '0 2 * * *' };
const queue = { kind: 'queue-message' as const, queue: 'post' };

const servicesWithTriggers = (services: { tenant: string; id: string; triggers: unknown[] }[]) =>
  ({
    capabilities: async () => services.map((s) => ({ service: { tenant: s.tenant } })),
    list: async (tenant: string) =>
      services.filter((s) => s.tenant === tenant).map((s) => ({ kind: 'Service', id: s.id })),
    get: async (_kind: string, tenant: string, id: string) => {
      const found = services.find((s) => s.tenant === tenant && s.id === id);
      return found && { definition: { kind: 'Service', spec: { triggers: found.triggers } } };
    },
  }) as unknown as TestIdEraDeps['definitions'];

const setup = async () => {
  const keys = new InMemoryTenantApiKeys();
  const config = new InMemoryConfigEntryStore();
  const records = new InMemoryAdminRecords();
  const key = (id: string, tenant: string, fields: Record<string, unknown> = {}) =>
    keys.add({
      id,
      name: id,
      digest: id.padEnd(64, '0'),
      tenant,
      scopes: ['query'],
      datasets: [],
      agents: [],
      ...fields,
    });
  const entry = (kind: string, scope: string, id: string, spec: Record<string, unknown>) =>
    appendVersion(config, { kind, scope, id, spec, deleted: false, by: 'kari', reason: 'test' });
  let definitions = servicesWithTriggers([]);
  const withServices = (services: Parameters<typeof servicesWithTriggers>[0]) => {
    definitions = servicesWithTriggers(services);
  };
  const markerDeps = {
    platformTenant: DIGDIR,
    config,
    audit: (e: Parameters<typeof records.appendAudit>[0]) => records.appendAudit(e),
    now,
    newId: () => crypto.randomUUID(),
  };
  let apiKeys: TestIdEraDeps['apiKeys'] = keys;
  const failKeysOnce = (after: number) => {
    let calls = 0;
    apiKeys = {
      unadmitted: () => keys.unadmitted(),
      revoke: async (tenant, id, at) => {
        calls += 1;
        if (calls === after + 1) throw new Error('the database went away');
        return keys.revoke(tenant, id, at);
      },
    };
  };
  const run = (configured: string[] = []) =>
    revokeTestIdEra({
      ...markerDeps,
      apiKeys,
      configuredKeys: new Set(configured),
      definitions,
      audited: (tenant) => records.audit(tenant),
    });
  const forget = () => forgetTestIdEraRevocation(markerDeps);
  const live = async (tenant: string) =>
    (await keys.list(tenant)).filter((k) => !k.revokedAt).map((k) => k.id);
  return { keys, config, records, key, entry, run, forget, live, withServices, failKeysOnce };
};

describe('revoking TestID-era credentials at the production login switch', () => {
  it('runs only on genki-test on production Ansattporten without Altinn, never on prod', () => {
    const test = { GENAI_ENV: 'test', ANSATTPORTEN_ISSUER: productionAnsattporten };
    expect(revokesTestIdEra(test, true)).toBe(true);
    expect(revokesTestIdEra(test, false)).toBe(false);
    expect(
      revokesTestIdEra({ ...test, ANSATTPORTEN_ISSUER: 'https://test.ansattporten.no' }, true),
    ).toBe(false);
    expect(revokesTestIdEra({ ...test, GENAI_ENV: 'prod' }, true)).toBe(false);
    expect(
      forgetsTestIdEraRevocation({ ...test, ANSATTPORTEN_ISSUER: 'https://test.ansattporten.no' }),
    ).toBe(true);
    expect(forgetsTestIdEraRevocation(test)).toBe(false);
    expect(forgetsTestIdEraRevocation({ GENAI_ENV: 'prod' })).toBe(false);
  });

  it('after an undo, switching again revokes keys made during the undo', async () => {
    const s = await setup();
    await s.run();
    expect(await s.forget()).toBe(true);
    await s.key('during-undo', SYNTHETIC);

    expect((await s.run())?.keys).toBe(1);

    expect(await s.live(SYNTHETIC)).toEqual([]);
    expect((await s.records.audit(DIGDIR)).map((a) => a.action)).toEqual([
      'platform.production-login.reset',
    ]);
  });

  it('a failure halfway and a rerun leave one audit entry per revocation', async () => {
    const s = await setup();
    for (const id of ['one', 'two', 'three']) await s.key(id, SYNTHETIC);
    s.failKeysOnce(1);

    await expect(s.run()).rejects.toThrow('the database went away');
    expect((await s.run())?.keys).toBe(2);

    expect(await s.live(SYNTHETIC)).toEqual([]);
    expect((await s.records.audit(SYNTHETIC)).map((a) => a.target).sort()).toEqual(
      ['one', 'three', 'two'].map((id) => `api-key:${SYNTHETIC}/${id}`),
    );
  });

  it('does not overwrite a pipeline someone changed while it ran', async () => {
    const s = await setup();
    await s.entry('ingestion-pipeline', SYNTHETIC, 'docs#nightly', { schedule: 'daily' });
    const latest = s.config.latest.bind(s.config);
    s.config.latest = async (filter) => {
      const found = await latest(filter);
      if (filter?.kind === 'ingestion-pipeline')
        await s.entry('ingestion-pipeline', SYNTHETIC, 'docs#nightly', { schedule: 'weekly' });
      return found;
    };

    await expect(s.run()).rejects.toThrow(/version/);

    const [pipeline] = await latest({ kind: 'ingestion-pipeline' });
    expect(pipeline?.spec).toEqual({ schedule: 'weekly' });
  });

  it('fails when it cannot record that it ran, so it does not count as done', async () => {
    const s = await setup();
    const append = s.config.append.bind(s.config);
    s.config.append = async (entry) => {
      if (
        entry.kind === 'production-login-switch' &&
        (entry.spec as { state?: string }).state === 'done'
      )
        throw new Error('the config store went away');
      return append(entry);
    };
    await s.key('testid', SYNTHETIC);

    await expect(s.run()).rejects.toThrow('the config store went away');
  });

  it('a key made before the switch in another organisation is revoked', async () => {
    const s = await setup();
    await s.key('testid', SYNTHETIC);

    await s.run();

    expect(await s.live(SYNTHETIC)).toEqual([]);
  });

  it('a key made by a group member still works', async () => {
    const s = await setup();
    await s.key('member', DIGDIR, { admittedInLockdown: true });

    await s.run();

    expect(await s.live(DIGDIR)).toEqual(['member']);
  });

  it('a key without the mark is revoked in the platform organisation too', async () => {
    const s = await setup();
    await s.key('unmarked', DIGDIR);

    await s.run();

    expect(await s.live(DIGDIR)).toEqual([]);
  });

  it('a key from configuration is kept', async () => {
    const s = await setup();
    await s.key('configured', DIGDIR);

    await s.run(['configured'.padEnd(64, '0')]);

    expect(await s.live(DIGDIR)).toEqual(['configured']);
  });

  it('a Maskinporten client a TestID person registered is removed, one an Entra login registered stays', async () => {
    const s = await setup();
    await s.entry(maskinportenClientKind, SYNTHETIC, 'old-client', { clientId: 'old-client' });
    await s.entry(maskinportenClientKind, DIGDIR, 'new-client', {
      clientId: 'new-client',
      admittedInLockdown: true,
    });

    await s.run();

    const latest = await s.config.latest({ kind: maskinportenClientKind });
    expect(Object.fromEntries(latest.map((e) => [e.id, e.deleted]))).toEqual({
      'old-client': true,
      'new-client': false,
    });
  });

  it('its scheduled ingestion outside the platform organisation does not run', async () => {
    const s = await setup();
    await s.entry('ingestion-pipeline', SYNTHETIC, 'docs#nightly', {
      enabled: true,
      schedule: 'daily',
    });
    await s.entry('ingestion-pipeline', DIGDIR, 'kudos#nightly', {
      enabled: true,
      schedule: 'daily',
    });
    await s.entry('ingestion-pipeline', 'platform', 'shared#weekly', {
      enabled: true,
      schedule: 'weekly',
    });

    await s.run();

    const latest = await s.config.latest({ kind: 'ingestion-pipeline' });
    expect(
      Object.fromEntries(latest.map((e) => [e.id, (e.spec as { schedule: string }).schedule])),
    ).toEqual({ 'docs#nightly': 'none', 'kudos#nightly': 'daily', 'shared#weekly': 'weekly' });
  });

  it('a scheduled trigger on a service outside the platform organisation does not run after the switch', async () => {
    const s = await setup();
    s.withServices([
      { tenant: SYNTHETIC, id: 'post', triggers: [nightly, queue] },
      { tenant: DIGDIR, id: 'kudos', triggers: [nightly] },
    ]);

    expect((await s.run())?.triggers).toBe(1);

    const paused = await s.config.latest({ kind: triggerPauseKind });
    expect(paused.map((e) => [e.scope, e.id, e.deleted])).toEqual([
      [SYNTHETIC, triggerId('post', nightly), false],
    ]);
    expect((await s.records.audit(SYNTHETIC)).map((a) => [a.action, a.reason])).toEqual([
      ['platform.trigger.pause', testIdEraReason],
    ]);
  });

  it('writes each revocation to the audit log with the reason', async () => {
    const s = await setup();
    await s.key('testid', SYNTHETIC);
    await s.entry(maskinportenClientKind, SYNTHETIC, 'old-client', { clientId: 'old-client' });
    await s.entry('ingestion-pipeline', SYNTHETIC, 'docs#nightly', { schedule: 'daily' });

    expect(await s.run()).toEqual({ keys: 1, clients: 1, schedules: 1, triggers: 0 });

    const audit = await s.records.audit(SYNTHETIC);
    expect(audit.map((a) => [a.action, a.target, a.reason])).toEqual([
      ['platform.apikeys.revoke', `api-key:${SYNTHETIC}/testid`, testIdEraReason],
      [
        'platform.maskinporten-client.remove',
        `maskinporten-client:${SYNTHETIC}/old-client`,
        testIdEraReason,
      ],
      ['platform.pipeline.save', 'pipeline:docs/nightly', testIdEraReason],
    ]);
  });

  it('runs once, so a key made after the switch is never revoked by a later start', async () => {
    const s = await setup();
    await s.run();
    await s.key('later', DIGDIR);

    expect(await s.run()).toBeUndefined();

    expect(await s.live(DIGDIR)).toEqual(['later']);
  });
});
