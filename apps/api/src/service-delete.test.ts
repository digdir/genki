import { afterEach, describe, expect, it, vi } from 'vitest';
import { textPart, type Principal } from '@genai/contracts';
import { bootPlatform, digdir, files, other, readJson, testService } from './testkit.js';

const person = (subject: string, tenant: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant,
  authorizedFor: [{ org: tenant, actions }],
});

const system: Principal = {
  kind: 'agency-system',
  issuer: 'test',
  subject: 'saksbehandling',
  tenant: digdir,
  scopes: ['legacy:query'],
};

const people = {
  system,
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir } as Principal,
  eier: person('eier', digdir, ['use-services', 'manage-services', 'view-usage']),
  leser: person('leser', digdir, ['use-services']),
  ola: person('ola', other, ['use-services', 'manage-services']),
};

const reason = 'Rydder bort testtjenester';

const flow = (id: string, subflow?: string) => ({
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant: digdir, id, name: `Flyt ${id}` },
  spec: {
    purpose: 'Svarer på spørsmålet',
    steps: subflow
      ? [{ id: 'under', subflow }]
      : [{ id: 'svar', block: 'answer@1', input: { text: '{{input.query}}' } }],
  },
});

const usingFlow = (id: string, flowRef: string, tenant = digdir) => {
  const service = testService(id, tenant);
  return {
    ...service,
    spec: { ...service.spec, strategy: { id: 'step-flow', version: 1, config: { flow: flowRef } } },
  };
};

const recipe = {
  title: { nb: 'Felles flyt', en: 'Shared flow' },
  summary: { nb: 'Svarer', en: 'Answers' },
};

const boot = async () => {
  const booted = await bootPlatform({ people, services: ['testtjeneste'] });
  const publish = async (definition: unknown, withFiles: Record<string, string> = files) => {
    const result = await booted.platform.definitions.publish(
      definition,
      'test',
      'oppsett',
      withFiles,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  };
  const setState = (id: string, state: string) =>
    booted.send(`/tenants/${digdir}/services/${id}/lifecycle`, 'eier', {
      method: 'PUT',
      body: { state },
      reason: 'Tjenesten skal ryddes bort',
    });
  const remove = (id: string, as = 'eier', tenant = digdir, withReason: string | null = reason) =>
    booted.send(`/tenants/${tenant}/services/${id}`, as, {
      method: 'DELETE',
      ...(withReason ? { reason: withReason } : {}),
    });
  const stored = (kind: 'Service' | 'StepFlow', id: string) =>
    booted.platform.definitions.versions(kind, digdir, id);
  return { ...booted, publish, setState, remove, stored };
};

afterEach(() => vi.restoreAllMocks());

describe('deleting a service', () => {
  it('only an archived service can be deleted; an active or paused one is refused with a message to archive first', async () => {
    const { remove, setState, stored } = await boot();

    const active = await remove('testtjeneste');
    await setState('testtjeneste', 'paused');
    const paused = await remove('testtjeneste');

    for (const refused of [active, paused]) {
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({
        type: 'urn:genai:problem:service-not-archived',
        errors: [{ path: 'lifecycle', message: expect.stringContaining('Arkiver tjenesten') }],
      });
    }
    expect(await stored('Service', 'testtjeneste')).toHaveLength(1);
  });

  it('removes the definition, all its versions and its draft at once', async () => {
    const { send, publish, setState, remove, stored } = await boot();
    await publish(testService('testtjeneste'));
    const draft = await send(`/tenants/${digdir}/services/testtjeneste/draft`, 'eier', {
      method: 'PUT',
      body: { definition: testService('testtjeneste'), files },
      reason: 'Lagrer et utkast',
    });
    expect(draft.status).toBe(200);
    await setState('testtjeneste', 'archived');

    const deleted = await remove('testtjeneste');

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      id: 'testtjeneste',
      deleted: true,
      versions: 2,
      stepFlows: [],
    });
    expect(await stored('Service', 'testtjeneste')).toEqual([]);
    expect(
      await (await send(`/tenants/${digdir}/services/testtjeneste/draft`, 'eier')).json(),
    ).toBe(null);
    expect((await send(`/tenants/${digdir}/services/testtjeneste/lifecycle`, 'eier')).status).toBe(
      404,
    );
  });

  it('removes the step flows only the service used and keeps one another stored service version uses', async () => {
    const { publish, setState, remove, stored } = await boot();
    await publish(flow('egen-under'), {});
    await publish(flow('egen', 'egen-under@1'), {});
    await publish(flow('delt'), {});
    await publish(flow('frittstaende'), {});
    await publish(usingFlow('rydd', 'egen@1'), {});
    await publish(usingFlow('rydd', 'delt@1'), {});
    await publish(usingFlow('annen', 'delt@1'), {});
    await publish(usingFlow('annen', 'frittstaende@1'), {});
    await setState('rydd', 'archived');

    const deleted = await remove('rydd');

    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { stepFlows: string[] }).stepFlows).toEqual([
      'egen',
      'egen-under',
    ]);
    expect(await stored('StepFlow', 'egen')).toEqual([]);
    expect(await stored('StepFlow', 'egen-under')).toEqual([]);
    expect(await stored('StepFlow', 'delt')).toHaveLength(1);
    expect(await stored('StepFlow', 'frittstaende')).toHaveLength(1);
  });

  it('a step flow another organisation uses through sharing is kept', async () => {
    const { publish, setState, remove, stored, configEntries } = await boot();
    await publish({ ...flow('felles'), spec: { ...flow('felles').spec, recipe } }, {});
    await configEntries.append({
      kind: 'recipe-share',
      scope: digdir,
      id: 'felles',
      version: 1,
      spec: { flow: 'felles', state: 'shared' },
      deleted: false,
      by: 'operator:test:drift',
      at: '2026-11-19T10:00:00Z',
      reason: 'Deler oppskriften',
    });
    await publish(usingFlow('rydd', 'felles@1'), {});
    await publish(usingFlow('annen', 'felles@1', other), {});
    await setState('rydd', 'archived');

    const deleted = await remove('rydd');

    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { stepFlows: string[] }).stepFlows).toEqual([]);
    expect(await stored('StepFlow', 'felles')).toHaveLength(1);
  });

  it('runs of a deleted internal service stay hidden from tenant members', async () => {
    const { platform, admin, configEntries, send, publish } = await boot();
    const internal = testService('roykprove');
    await publish({ ...internal, spec: { ...internal.spec, visibility: 'internal' } });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const run = await platform.kernel.invoke(system, `${digdir}/roykprove/default`, {
      data: { query: 'Hei' },
      parts: [textPart('Hei')],
    });
    await run.result.catch(() => undefined);
    await configEntries.append({
      kind: 'service-lifecycle',
      scope: digdir,
      id: 'roykprove',
      version: 1,
      spec: { state: 'archived' },
      deleted: false,
      by: 'operator:test:drift',
      at: '2026-11-19T10:00:00Z',
      reason: 'Røykprøven trengs ikke',
    });

    const deleted = await admin.perform(people.eier, 'platform.service.delete', {
      tenant: digdir,
      id: 'roykprove',
      reason,
    });
    const listed = async (as: string) =>
      (
        await readJson<{ data: { task?: string; id?: string }[] }>(
          await send(`/tenants/${digdir}/tasks`, as),
        )
      ).data.map((t) => t.task ?? t.id);

    expect(deleted.ok).toBe(true);
    expect(await platform.definitions.versions('Service', digdir, 'roykprove')).toEqual([]);
    expect(await listed('eier')).not.toContain(run.task);
    expect((await send(`/tenants/${digdir}/tasks/${run.task}`, 'eier')).status).toBe(404);
    const { status } = await platform.kernel.task(system, run.task);
    const forOperator = await send(`/operator/tasks?status=${status}`, 'drift');
    expect(await forOperator.text()).toContain(run.task);
  });

  it('keeps run history readable after the service is deleted', async () => {
    const { platform, send, setState, remove } = await boot();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const run = await platform.kernel.invoke(system, `${digdir}/testtjeneste/default`, {
      data: { query: 'Hei' },
      parts: [textPart('Hei')],
    });
    await run.result.catch(() => undefined);
    await setState('testtjeneste', 'archived');

    expect((await remove('testtjeneste')).status).toBe(200);

    const list = await send(`/tenants/${digdir}/tasks`, 'eier');
    expect(list.status).toBe(200);
    expect(
      (await readJson<{ data: { task?: string; id?: string }[] }>(list)).data.map(
        (t) => t.task ?? t.id,
      ),
    ).toContain(run.task);
    expect((await send(`/tenants/${digdir}/tasks/${run.task}`, 'eier')).status).toBe(200);
    expect((await send(`/tenants/${digdir}/usage`, 'eier')).status).toBe(200);
  });

  it('is audited with the change reason, needs manage-services and a change reason', async () => {
    const { admin, setState, remove } = await boot();
    await setState('testtjeneste', 'archived');

    expect((await remove('testtjeneste', 'leser')).status).toBe(403);
    expect((await remove('testtjeneste', 'eier', digdir, null)).status).toBe(400);
    expect((await remove('testtjeneste')).status).toBe(200);
    expect(
      (await admin.audit(digdir)).find((a) => a.action === 'platform.service.delete'),
    ).toMatchObject({
      outcome: 'applied',
      target: `service:${digdir}/testtjeneste`,
      reason,
      actor: 'employee:test:eier',
    });
  });

  it('never deletes a service in another organisation', async () => {
    const { setState, remove, stored } = await boot();
    await setState('testtjeneste', 'archived');

    const fromOther = await remove('testtjeneste', 'ola', digdir);

    expect(fromOther.status).toBe(404);
    expect(await stored('Service', 'testtjeneste')).toHaveLength(1);
  });

  it('is refused while a frontend, an API key or another service depends on the service', async () => {
    const { send, publish, setState, remove, stored } = await boot();
    const frontend = await send(`/tenants/${digdir}/clients/test-web`, 'eier', {
      method: 'PUT',
      reason: 'Kobler til en frontend',
      body: {
        metadata: { name: 'Testappen' },
        spec: {
          service: 'testtjeneste',
          kind: 'browser',
          url: 'http://localhost:5177',
          channels: ['openai'],
          allowedOrigins: ['http://localhost:5177'],
          oidc: { clientId: 'test-web', redirectUris: ['http://localhost:5177/callback'] },
        },
      },
    });
    expect(frontend.status).toBe(200);
    const key = await send(`/tenants/${digdir}/services/testtjeneste/api-keys`, 'eier', {
      body: { name: 'Backend' },
      reason: 'Nøkkel til backend',
    });
    expect(key.status).toBe(201);
    const caller = testService('kaller');
    await publish(
      {
        ...caller,
        spec: {
          ...caller.spec,
          strategy: {
            id: 'remote-agent',
            version: 1,
            config: {
              endpoint: {
                url: 'https://genki.example.no/a2a/testtjeneste__default',
                protocol: 'a2a',
                residency: 'norway',
              },
            },
          },
        },
      },
      {},
    );
    await setState('testtjeneste', 'archived');

    const refused = await remove('testtjeneste');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      type: 'urn:genai:problem:service-in-use',
      errors: [
        { path: 'frontends', message: expect.stringContaining('Testappen') },
        { path: 'apiKeys', message: expect.stringContaining('Backend') },
        { path: 'services', message: expect.stringContaining('kaller') },
      ],
    });
    expect(await stored('Service', 'testtjeneste')).toHaveLength(1);
  });

  it('lets the id be used again for a new service after deletion', async () => {
    const { platform, send, setState, remove } = await boot();
    await setState('testtjeneste', 'archived');
    expect((await remove('testtjeneste')).status).toBe(200);

    const again = await platform.definitions.publish(
      testService('testtjeneste'),
      'test',
      'ny tjeneste med samme id',
      files,
    );

    expect(again).toMatchObject({ ok: true, version: { version: 1 } });
    expect(
      await readJson<{ state: string }>(
        await send(`/tenants/${digdir}/services/testtjeneste/lifecycle`, 'eier'),
      ),
    ).toMatchObject({ state: 'active' });
  });

  it('no longer counts the deleted service as a catalog reference', async () => {
    const { platform, setState, remove } = await boot();
    await setState('testtjeneste', 'archived');
    expect(
      (await platform.definitions.capabilities()).some((c) => c.service.id === 'testtjeneste'),
    ).toBe(true);

    expect((await remove('testtjeneste')).status).toBe(200);

    expect(
      (await platform.definitions.capabilities()).some((c) => c.service.id === 'testtjeneste'),
    ).toBe(false);
  });
});
