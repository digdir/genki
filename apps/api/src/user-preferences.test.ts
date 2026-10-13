import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { tenantAccess } from './access.js';
import type { Admin } from './admin.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import type { ModuleDeps, MountDeps } from './platform-modules.js';
import { digdir, other } from './testkit.js';
import { userPreferences, userPreferencesModule } from './user-preferences.js';

const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir };

const people: Record<string, Principal> = {
  kari,
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: digdir },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: other,
    authorizedFor: [{ org: digdir, actions: [] }],
  },
};

const boot = () => {
  const configEntries = new InMemoryConfigEntryStore();
  const app = new Hono();
  userPreferencesModule({ configEntries } as unknown as ModuleDeps).mount(app, {
    authenticate: async (request: Request) =>
      people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
    access: tenantAccess({ supportSession: () => undefined } as unknown as Admin),
  } as unknown as MountDeps);
  const call = (who: string, init: { body?: unknown; reason?: string; tenant?: string } = {}) =>
    app.request(`/tenants/${init.tenant ?? digdir}/me/preferences`, {
      method: init.body === undefined ? 'GET' : 'PUT',
      headers: {
        authorization: `Bearer ${who}`,
        'content-type': 'application/json',
        ...(init.reason ? { 'change-reason': init.reason } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { app, call, configEntries };
};

describe('user preferences', () => {
  it('saves a written standard for the person only, with a reason in the history', async () => {
    const { call, configEntries } = boot();

    const saved = await call('kari', {
      body: { writtenStandard: 'nynorsk' },
      reason: 'Endret målform i brukermenyen',
    });

    expect(saved.status).toBe(200);
    expect(await (await call('kari')).json()).toMatchObject({ writtenStandard: 'nynorsk' });
    expect(await (await call('ola')).json()).toEqual({ writtenStandard: null, language: null });
    expect(await userPreferences(configEntries).writtenStandard(digdir, kari)).toBe('nynorsk');
    const history = await userPreferences(configEntries).latest(digdir, kari);
    expect(history).toMatchObject({
      by: 'employee:test:kari',
      reason: 'Endret målform i brukermenyen',
    });
  });

  it('clears the preference with null and refuses unknown values or a missing reason', async () => {
    const { call } = boot();
    await call('kari', { body: { writtenStandard: 'bokmal' }, reason: 'Velger bokmål i svarene' });

    const cleared = await call('kari', {
      body: { writtenStandard: null },
      reason: 'Tilbake til samme som spørsmålet',
    });
    const unknown = await call('kari', { body: { writtenStandard: 'svensk' }, reason: 'Ugyldig' });
    const noReason = await call('kari', { body: { writtenStandard: 'nynorsk' } });

    expect(await cleared.json()).toMatchObject({ writtenStandard: null });
    expect(unknown.status).toBe(400);
    expect(noReason.status).toBe(400);
  });

  it('keeps the language next to the written standard and changes only the fields sent', async () => {
    const { call, configEntries } = boot();
    await call('kari', { body: { writtenStandard: 'nynorsk' }, reason: 'Endret målform i menyen' });

    const english = await call('kari', {
      body: { language: 'en' },
      reason: 'Chose English in the menu',
    });
    expect(await english.json()).toMatchObject({ writtenStandard: 'nynorsk', language: 'en' });
    expect(await userPreferences(configEntries).of(digdir, kari)).toEqual({
      writtenStandard: 'nynorsk',
      language: 'en',
    });

    const browser = await call('kari', {
      body: { language: null },
      reason: 'Følg nettleseren igjen',
    });
    expect(await browser.json()).toMatchObject({ writtenStandard: 'nynorsk', language: null });
    const unknown = await call('kari', { body: { language: 'sv' }, reason: 'Ugyldig språkvalg' });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ title: 'Ugyldig språk' });
  });

  it('tells the workspace which platform rights the person has in the tenant', async () => {
    const { app } = boot();
    const rights = async (who: string) =>
      (
        (await (
          await app.request(`/tenants/${digdir}/me`, {
            headers: { authorization: `Bearer ${who}` },
          })
        ).json()) as { rights: string[] }
      ).rights;

    expect(await rights('kari')).toContain('use-services');
    expect(await rights('erik')).toEqual([]);
  });

  it('is only reachable in tenants the person belongs to', async () => {
    const { call } = boot();

    expect((await call('kari', { tenant: other })).status).toBe(404);
  });
});
