import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, files, readJson, testService } from './testkit.js';

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
};

const marker = 'plattformverdi-som-aldri-skal-vises-31f2';
const reason = 'Rydder bort en ubrukt nøkkel';

const boot = async () => {
  const booted = await bootPlatform({ people });
  const remove = (name: string, as = 'drift', withReason = reason) =>
    booted.send(`/operator/secrets/${name}`, as, {
      method: 'DELETE',
      ...(withReason ? { reason: withReason } : {}),
    });
  const listed = async () =>
    (
      await readJson<{ data: { name: string }[] }>(await booted.send('/operator/secrets', 'drift'))
    ).data.map((s) => s.name);
  return { ...booted, remove, listed };
};

describe('deleting a platform secret', () => {
  it('deletes an unused platform secret, audits it without the value and stops listing it', async () => {
    const { platform, remove, listed, admin } = await boot();
    await platform.vault.set('platform', 'nimbrel-api-key', marker);
    expect(await listed()).toContain('nimbrel-api-key');

    const removed = await remove('nimbrel-api-key');

    expect(removed.status).toBe(204);
    expect(await platform.vault.names('platform')).toEqual([]);
    expect(await listed()).not.toContain('nimbrel-api-key');
    const audit = await admin.audit();
    expect(audit.find((a) => a.action === 'platform.platform-secret.delete')).toMatchObject({
      outcome: 'applied',
      target: 'secret:platform/nimbrel-api-key',
      actor: 'operator:test:drift',
      reason,
    });
    expect(JSON.stringify(audit)).not.toContain(marker);
  });

  it('refuses with 409 a platform secret an internal service uses', async () => {
    const { platform, remove } = await boot();
    await platform.vault.set('platform', 'smoke-nokkel', marker);
    const service = testService('smoke');
    const published = await platform.definitions.publish(
      {
        ...service,
        spec: {
          ...service.spec,
          purpose: 'secret://platform/smoke-nokkel',
          visibility: 'internal',
        },
      },
      'test',
      'Røyktesten bruker nøkkelen',
      files,
    );
    expect(published.ok).toBe(true);

    const refused = await remove('smoke-nokkel');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      type: 'urn:genai:problem:platform-secret-in-use',
      usedBy: [{ kind: 'Service', id: `${digdir}/smoke` }],
    });
    expect(await platform.vault.names('platform')).toEqual(['smoke-nokkel']);
  });

  it('refuses with 409 a platform secret a model endpoint names', async () => {
    const { platform, remove, send } = await boot();
    await platform.vault.set('platform', 'lab-nokkel', marker);
    const saved = await send('/operator/model-endpoints', 'drift', {
      body: {
        id: 'lab',
        families: { openai: '' },
        baseURL: 'https://modell.example.no/v1',
        auth: { kind: 'api-key', secret: 'secret://platform/lab-nokkel' },
      },
      reason: 'Ny tilkobling til laben',
    });
    expect(saved.status, await saved.clone().text()).toBeLessThan(300);

    const refused = await remove('lab-nokkel');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      usedBy: [{ kind: 'model-endpoint', id: 'lab' }],
    });
    expect(await platform.vault.names('platform')).toEqual(['lab-nokkel']);
  });

  it('refuses with 409 a platform secret an operator hook names', async () => {
    const { platform, remove, send } = await boot();
    await platform.vault.set('platform', 'krok-nokkel', marker);
    const saved = await send('/operator/hooks/varsel', 'drift', {
      method: 'PUT',
      body: {
        name: 'Varsel',
        point: 'task_completed',
        handler: { kind: 'webhook', url: 'https://krok.example.no/varsel', secret: 'krok-nokkel' },
      },
      reason: 'Varsel til driften',
    });
    expect(saved.status).toBe(200);

    const refused = await remove('krok-nokkel');

    expect(refused.status).toBe(409);
    expect(await platform.vault.names('platform')).toEqual(['krok-nokkel']);
  });

  it('is for operators only and needs a change reason', async () => {
    const { platform, remove } = await boot();
    await platform.vault.set('platform', 'nokkel', marker);

    expect((await remove('nokkel', 'kari')).status).toBe(403);
    expect((await remove('nokkel', 'drift', '')).status).toBe(400);
    expect(await platform.vault.names('platform')).toEqual(['nokkel']);
  });

  it('answers 404 for a platform secret that is not stored', async () => {
    const { remove } = await boot();

    expect((await remove('finnes-ikke')).status).toBe(404);
  });
});
