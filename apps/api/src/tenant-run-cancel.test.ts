import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { envSecrets, InMemoryTaskStore } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { createPlatform } from './composition.js';
import { digdir, files, klarsprak } from './testkit.js';

const other = '889640782';
const servers: FakeServer[] = [];
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const open of gates.splice(0)) open();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const member = (subject: string, tenant: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant,
  authorizedFor: [{ org: tenant, actions }],
});

const people: Record<string, Principal> = {
  kari: member('kari', digdir, ['use-services']),
  per: member('per', digdir, ['use-services']),
  admin: member('admin', digdir, ['use-services', 'manage-services']),
  lead: member('lead', digdir, ['manage-services']),
  ola: member('ola', other, ['use-services', 'manage-services']),
};

const boot = async () => {
  const model = await fakeHttp(async () => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return {
      status: 200,
      json: {
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-test',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Svar.' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    };
  });
  servers.push(model);
  const settings = new SettingsRegistry(platformSettings);
  const tasks = new InMemoryTaskStore();
  const platform = await createPlatform({
    tasks,
    catalogs: {
      models: {
        endpoints: {
          fake: {
            families: { openai: '' },
            baseURL: model.url,
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [{ id: 'fake/gpt', endpoint: 'fake', deployment: 'gpt', residency: 'norway' }],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = people[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
  await platform.directory.add({ orgNumber: other, name: 'Testetaten', status: 'active' }, 'test');
  const definition = klarsprak({ id: 'klarsprak' });
  await platform.definitions.publish(
    {
      ...definition,
      spec: { ...definition.spec, model: { primary: 'fake/gpt', residency: 'norway' } },
    },
    'test',
    'test',
    files,
  );
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      auth: { authenticate: async () => undefined },
      tenantGate: platform.tenantGate,
    },
  });
  platform.mount(app, admin);
  const capability = (await platform.definitions.capabilities())[0]?.capability.descriptor.id ?? '';
  const start = async (who: string, entryPoint?: string) => {
    const run = await platform.kernel.invoke(
      people[who] as Principal,
      capability,
      { data: { text: 'Skriv enklere.' } },
      entryPoint ? { entryPoint } : {},
    );
    void run.result.catch(() => undefined);
    await expect.poll(() => model.seen.length).toBeGreaterThan(0);
    return run.task;
  };
  const cancel = (tenant: string, task: string, who: string, reason = 'stopper kjøringen') =>
    app.request(`/tenants/${tenant}/tasks/${task}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who}`, 'change-reason': reason },
    });
  const audit = async () =>
    (await admin.audit(digdir)).filter((e) => e.action === 'platform.run.cancel');
  const makeChild = async (task: string) => {
    const stored = await tasks.get(task);
    if (stored) await tasks.put({ ...stored, task: { ...stored.task, parent: 'parent-task' } });
  };
  const statusOf = async (task: string) => (await tasks.get(task))?.task.status;
  const finish = async (task: string) => {
    const stored = await tasks.get(task);
    if (stored) await tasks.put({ ...stored, task: { ...stored.task, status: 'completed' } });
  };
  return { start, cancel, audit, platform, makeChild, statusOf, finish };
};

describe('stopping one run from the tenant', () => {
  it('lets who started a run stop it, and records the stop in the audit log', async () => {
    const { start, cancel, audit } = await boot();
    const task = await start('kari', 'rest');

    const res = await cancel(digdir, task, 'kari');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ task, status: 'cancelled' });
    expect(await audit()).toMatchObject([
      { outcome: 'applied', target: `task:${task}`, reason: 'stopper kjøringen' },
    ]);
  });

  it("refuses someone else's run without manage-services, and lets one who has it stop it", async () => {
    const { start, cancel } = await boot();
    const task = await start('kari', 'rest');

    expect((await cancel(digdir, task, 'per')).status).toBe(403);
    expect((await cancel(digdir, task, 'admin')).status).toBe(200);
  });

  it("lets one with only manage-services stop someone else's run", async () => {
    const { start, cancel, audit } = await boot();
    const task = await start('kari', 'rest');

    expect((await cancel(digdir, task, 'lead')).status).toBe(200);
    expect(await audit()).toMatchObject([{ outcome: 'applied', target: `task:${task}` }]);
  });

  it("refuses one with only use-services to stop someone else's run, and leaves it running", async () => {
    const { start, cancel, statusOf } = await boot();
    const task = await start('kari', 'rest');

    expect((await cancel(digdir, task, 'per')).status).toBe(403);
    expect(await statusOf(task)).toBe('running');
  });

  it("answers 404 for another organisation's run, also through the caller's own tenant", async () => {
    const { start, cancel } = await boot();
    const task = await start('kari', 'rest');

    expect((await cancel(digdir, task, 'ola')).status).toBe(404);
    expect((await cancel(other, task, 'ola')).status).toBe(404);
  });

  it('refuses a run that was not started through an API entry point', async () => {
    const { start, cancel } = await boot();
    const task = await start('kari');

    const res = await cancel(digdir, task, 'kari');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ type: 'urn:genai:problem:run-not-cancellable' });
  });

  it('refuses a child task, even one with an entry point', async () => {
    const { start, cancel, makeChild } = await boot();
    const task = await start('kari', 'rest');
    await makeChild(task);

    expect((await cancel(digdir, task, 'kari')).status).toBe(409);
  });

  it('refuses a run that has already finished', async () => {
    const { start, cancel, finish } = await boot();
    const task = await start('kari', 'rest');
    await finish(task);

    const res = await cancel(digdir, task, 'kari');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ type: 'urn:genai:problem:run-finished' });
  });

  it('refuses a stop without a change reason', async () => {
    const { start, cancel } = await boot();
    const task = await start('kari', 'rest');

    expect((await cancel(digdir, task, 'kari', 'kort')).status).toBe(400);
  });

  it('answers a stopped run with 200 again, without a second audit entry', async () => {
    const { start, cancel, audit } = await boot();
    const task = await start('kari', 'rest');
    await cancel(digdir, task, 'kari');

    const again = await cancel(digdir, task, 'kari');

    expect(again.status).toBe(200);
    expect(await audit()).toHaveLength(1);
  });
});
