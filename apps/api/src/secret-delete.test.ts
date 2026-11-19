import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { platformModules } from './composition.js';
import { bootPlatform, digdir, files, other, readJson, testService } from './testkit.js';

const person = (subject: string, tenant: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant,
  authorizedFor: [{ org: tenant, actions }],
});

const people = {
  admin: person('admin', digdir, ['use-services', 'manage-services']),
  bygger: person('bygger', digdir, ['use-services', 'register-building-blocks']),
  leser: person('leser', digdir, ['use-services']),
  ola: person('ola', other, ['use-services', 'manage-services']),
  owner: { ...person('eier', digdir, ['use-services', 'manage-services']), kind: 'operator' },
};

const hosts = ['https://krok.example.no'];
const marker = 'verdi-som-aldri-skal-vises-8c1d';
const reason = 'Rydder bort en gammel nøkkel';

const boot = async () => {
  const { send, platform } = await bootPlatform({ people, modules: platformModules });
  const remove = (tenant: string, name: string, as = 'admin') =>
    send(`/tenants/${tenant}/secrets/${name}`, as, { method: 'DELETE', reason });
  const saveHook = (id: string, secret: string) =>
    send(`/tenants/${digdir}/hooks/${id}`, 'admin', {
      method: 'PUT',
      body: {
        name: 'Varsel',
        point: 'task_completed',
        handler: { kind: 'webhook', url: 'https://krok.example.no/varsel', secret },
      },
      reason: 'Varsel til saksbehandling',
    });
  return { send, platform, remove, saveHook };
};

describe('deleting a tenant secret', () => {
  it('removes the secret, answers 204 and records the delete without the value', async () => {
    const { send, platform, remove } = await boot();
    await platform.vault.set(digdir, 'gammel-nokkel', marker, hosts);

    const removed = await remove(digdir, 'gammel-nokkel', 'bygger');
    const audit = await (await send(`/tenants/${digdir}/audit`, 'admin')).text();

    expect(removed.status).toBe(204);
    expect(await platform.vault.names(digdir)).toEqual([]);
    expect(audit).toContain('platform.secrets.delete');
    expect(audit).not.toContain(marker);
  });

  it('answers 204 for a secret that does not exist', async () => {
    const { remove } = await boot();

    expect((await remove(digdir, 'finnes-ikke')).status).toBe(204);
  });

  it('needs manage-services or register-building-blocks', async () => {
    const { platform, remove } = await boot();
    await platform.vault.set(digdir, 'nokkel', marker, hosts);

    const refused = await remove(digdir, 'nokkel', 'leser');

    expect(refused.status).toBe(403);
    expect(await platform.vault.names(digdir)).toEqual(['nokkel']);
  });

  it('a member without the right gets 403 for a secret in use, without its uses', async () => {
    const { platform, remove, saveHook } = await boot();
    await platform.vault.set(digdir, 'krok-nokkel', marker, hosts);
    expect((await saveHook('varsel', 'krok-nokkel')).status).toBe(200);

    const refused = await remove(digdir, 'krok-nokkel', 'leser');

    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain('usedBy');
  });

  it("cannot delete another tenant's secret or a platform secret", async () => {
    const { platform, remove } = await boot();
    await platform.vault.set(other, 'annen', marker, hosts);
    await platform.vault.set('platform', 'enhetsregisteret', marker);

    const otherTenant = await remove(other, 'annen');
    const platformOwner = await remove('platform', 'enhetsregisteret');

    expect(otherTenant.status).toBe(404);
    expect(platformOwner.status).toBe(404);
    expect(await platform.vault.names(other)).toEqual(['annen']);
    expect(await platform.vault.names('platform')).toEqual(['enhetsregisteret']);
  });

  it('an operator in the portal cannot delete a secret an internal service uses', async () => {
    const { platform, send } = await boot();
    await platform.vault.set(digdir, 'smoke-nokkel', marker, hosts);
    const service = testService('smoke');
    const published = await platform.definitions.publish(
      {
        ...service,
        spec: {
          ...service.spec,
          purpose: `secret://tenant/${digdir}/smoke-nokkel`,
          visibility: 'internal',
        },
      },
      'test',
      'Røyktesten bruker nøkkelen',
      files,
    );
    expect(published.ok).toBe(true);

    const refused = await send(`/tenants/${digdir}/secrets/smoke-nokkel`, 'owner', {
      method: 'DELETE',
      reason,
      headers: { 'genki-surface': 'portal' },
    });

    expect(refused.status).toBe(409);
    expect(await platform.vault.names(digdir)).toEqual(['smoke-nokkel']);
  });

  it('refuses with 409 a secret a hook still uses and names the hook', async () => {
    const { platform, remove, saveHook } = await boot();
    await platform.vault.set(digdir, 'krok-nokkel', marker, hosts);
    expect((await saveHook('varsel', 'krok-nokkel')).status).toBe(200);

    const refused = await remove(digdir, 'krok-nokkel');
    const body = await readJson<{ usedBy: { kind: string; id: string }[] }>(refused);

    expect(refused.status).toBe(409);
    expect(body.usedBy).toEqual([{ kind: 'hook', id: 'varsel' }]);
    expect(await platform.vault.names(digdir)).toEqual(['krok-nokkel']);
  });

  it('refuses with 409 a secret a tool connection still uses', async () => {
    const { send, platform, remove } = await boot();
    await platform.vault.set(digdir, 'arkiv-nokkel', marker, ['https://arkiv.example.no']);
    const registered = await send(`/tenants/${digdir}/tool-connections`, 'admin', {
      body: {
        id: 'arkiv',
        name: 'Arkiv',
        endpoint: 'https://arkiv.example.no/mcp',
        version: '1',
        allow: [{ host: 'arkiv.example.no' }],
        auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/arkiv-nokkel` },
      },
      reason: 'Ny MCP-tjener',
    });
    expect(registered.status).toBeLessThan(300);

    const refused = await remove(digdir, 'arkiv-nokkel');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      usedBy: [{ kind: 'tool-connection', id: 'arkiv' }],
    });
  });
});

describe('the secret a hook names', () => {
  it('a new hook names its secret with lowercase letters, digits and hyphens', async () => {
    const { saveHook } = await boot();

    const refused = await saveHook('varsel', 'krok_nokkel');
    const accepted = await saveHook('varsel', 'krok-nokkel');

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ errors: [{ path: 'spec.handler.secret' }] });
    expect(accepted.status).toBe(200);
  });

  it('a hook may keep naming a secret stored under an older name', async () => {
    const { platform, saveHook } = await boot();
    await platform.vault.set(digdir, 'krok.nokkel', marker, hosts);

    expect((await saveHook('varsel', 'krok.nokkel')).status).toBe(200);
  });
});
