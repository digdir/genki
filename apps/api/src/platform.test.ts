import type { Task } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { auth, digdir, files, klarsprak, other, plugins, principals, setup } from './testkit.js';

type Json = Record<string, unknown>;
const body = async <T = Json>(res: Response) => (await res.json()) as T;
const listed = async <T = Json>(res: Response) => (await body<{ data: T[] }>(res)).data;

const auditEvents = async (
  send: ReturnType<typeof setup>['send'],
  tenant: string,
  task: string,
  who = 'kari',
) =>
  (
    await body<{ events: { type: string; data: Json }[] }>(
      await send(`/tenants/${tenant}/audit/${task}`, who),
    )
  ).events;

describe('audit of administrative changes', () => {
  it('records the published definition and its version as the target of a publish', async () => {
    const { send, publish } = setup();

    await publish('kari', klarsprak());

    const audit = await listed<{ action: string; target: string }>(
      await send(`/tenants/${digdir}/audit`, 'kari'),
    );
    expect(audit.map((a) => [a.action, a.target])).toEqual([
      ['platform.service.publish', 'Service:klarsprak@1'],
    ]);
  });

  it('refuses a change reason shorter than 10 characters on a settings change', async () => {
    const { send } = setup();
    const change = (reason: string) =>
      send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
        method: 'PUT',
        body: { value: 40 },
        reason,
      });

    expect((await change('123456789')).status).toBe(400);
    expect((await change('1234567890')).status).toBe(200);
  });

  it('runs every mutation as a platform task with an audit event naming the action, target and reason', async () => {
    const { send, publish } = setup();

    const published = await publish('kari', klarsprak());
    const set = await send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
      method: 'PUT',
      body: { value: 40 },
      reason: 'færre treff',
    });
    const pinned = await send(`/tenants/${digdir}/pins/search.topK`, 'kari', {
      method: 'PUT',
      body: { version: 1 },
      reason: 'hold fast ved valget',
    });
    const unset = await send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
      method: 'DELETE',
      reason: 'tilbake til standard',
    });

    const tasks = [published, set, pinned, unset].map((r) => r.headers.get('genai-task'));
    expect([published.status, set.status, pinned.status, unset.status]).toEqual([
      201, 200, 200, 200,
    ]);
    const audit = await listed<{
      task: string;
      action: string;
      actor: string;
      outcome: string;
      reason: string;
    }>(await send(`/tenants/${digdir}/audit`, 'kari'));
    expect(audit.map((a) => [a.task, a.action, a.actor, a.outcome, a.reason])).toEqual([
      [tasks[0], 'platform.service.publish', 'employee:test:kari', 'applied', 'første versjon'],
      [tasks[1], 'platform.setting.set', 'employee:test:kari', 'applied', 'færre treff'],
      [tasks[2], 'platform.setting.pin', 'employee:test:kari', 'applied', 'hold fast ved valget'],
      [tasks[3], 'platform.setting.set', 'employee:test:kari', 'applied', 'tilbake til standard'],
    ]);
    for (const [i, task] of tasks.entries()) {
      const change = (await auditEvents(send, digdir, String(task))).find(
        (e) => e.type === 'x.platform.change',
      );
      expect(change?.data).toMatchObject({
        action: audit[i]?.action,
        tenant: digdir,
        reason: audit[i]?.reason,
      });
    }
    expect(
      (await auditEvents(send, digdir, String(tasks[0]))).find(
        (e) => e.type === 'x.platform.change',
      )?.data,
    ).toMatchObject({
      target: 'Service:klarsprak@1',
    });
  });

  it('decodes a URI-encoded change reason and keeps a plain one as sent', async () => {
    const { send, publish } = setup();
    const reason = 'Endring – «test» ’ æøå';

    const published = await publish('kari', klarsprak(), encodeURIComponent(reason));
    const set = await send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
      method: 'PUT',
      body: { value: 40 },
      reason: encodeURIComponent(reason),
    });
    const plain = await send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
      method: 'PUT',
      body: { value: 30 },
      reason: '100% plain ascii',
    });

    expect([published.status, set.status, plain.status]).toEqual([201, 200, 200]);
    const audit = await listed<{ task: string; reason: string }>(
      await send(`/tenants/${digdir}/audit`, 'kari'),
    );
    expect(audit.map((a) => a.reason)).toEqual([reason, reason, '100% plain ascii']);
    const change = (await auditEvents(send, digdir, String(set.headers.get('genai-task')))).find(
      (e) => e.type === 'x.platform.change',
    );
    expect(change?.data).toMatchObject({ reason });
  });

  it('records a refused change as rejected, with the errors, in the audit log', async () => {
    const { send } = setup();

    const res = await send(`/tenants/${digdir}/settings/tools.lovdata.key`, 'kari', {
      method: 'PUT',
      body: { value: 'sk-live-123' },
      reason: 'lim inn nøkkel',
    });

    expect(res.status).toBe(422);
    const [entry] = await listed<{ task: string; outcome: string }>(
      await send(`/tenants/${digdir}/audit`, 'kari'),
    );
    expect(entry?.outcome).toBe('rejected');
    const events = await auditEvents(send, digdir, String(entry?.task));
    expect(events.find((e) => e.type === 'x.platform.rejected')?.data).toMatchObject({
      action: 'platform.setting.set',
      errors: [{ path: 'tools.lovdata.key', message: 'a secret must be a secret:// reference' }],
    });
    expect(JSON.stringify(events.filter((e) => e.type.startsWith('x.')))).not.toContain(
      'sk-live-123',
    );
  });

  it("keeps a tenant's audit log away from other tenants", async () => {
    const { send, publish } = setup();
    const task = (await publish('kari', klarsprak())).headers.get('genai-task');

    expect((await send(`/tenants/${digdir}/audit`, 'ola')).status).toBe(404);
    expect((await send(`/tenants/${other}/audit/${task}`, 'ola')).status).toBe(404);
  });
});

describe('support sessions', () => {
  const open = (
    send: ReturnType<typeof setup>['send'],
    who: string,
    tenant = other,
    minutes = 30,
  ) =>
    send('/support-sessions', who, { body: { tenant, reason: 'feilsøking av sak 4711', minutes } });

  it('keeps operators out of a tenant until they open a session, which the tenant sees in its own log', async () => {
    const { send, publish } = setup();

    expect((await send(`/tenants/${other}/definitions`, 'operator')).status).toBe(404);
    const opened = await open(send, 'operator');
    expect(opened.status).toBe(201);
    const session = await body<{ id: string; operator: string; expiresAt: string }>(opened);
    expect(session).toMatchObject({
      operator: 'operator:test:drift',
      expiresAt: '2026-10-06T10:30:00.000Z',
    });

    const res = await publish(
      'operator',
      klarsprak({ tenant: other, id: 'annen' }),
      'retter feil',
      session.id,
    );
    expect(res.status).toBe(201);
    expect(await body(res)).toMatchObject({ publishedBy: 'operator:test:drift' });

    const audit = await listed<{
      action: string;
      actor: string;
      onBehalfOf?: string;
      tenant: string;
    }>(await send(`/tenants/${other}/audit`, 'ola'));
    expect(audit.map((a) => [a.action, a.actor, a.onBehalfOf, a.tenant])).toEqual([
      ['platform.support.open', 'operator:test:drift', other, other],
      ['platform.service.publish', 'operator:test:drift', other, other],
    ]);
  });

  it('refuses an expired session, a session for another tenant and a session opened by another operator', async () => {
    const { send, advance } = setup();
    const session = await body<{ id: string }>(await open(send, 'operator'));
    const list = (who: string, tenant = other) =>
      send(`/tenants/${tenant}/definitions`, who, { session: session.id });

    expect((await list('operator')).status).toBe(200);
    expect((await list('other-operator')).status).toBe(404);
    expect((await list('operator', '889640782')).status).toBe(404);
    advance(31);
    expect((await list('operator')).status).toBe(404);
  });

  it('stores the name the operator signed in with alongside the session', async () => {
    const { app } = setup();
    const opened = await app.request('/support-sessions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer operator',
        'content-type': 'application/json',
        'actor-name': encodeURIComponent('Ola Drift'),
      },
      body: JSON.stringify({ tenant: other, reason: 'feilsøking av sak 4711', minutes: 30 }),
    });

    expect(opened.status).toBe(201);
    expect(await body(opened)).toMatchObject({
      operator: 'operator:test:drift',
      operatorName: 'Ola Drift',
    });
  });

  it('only lets operators open sessions, and caps their length', async () => {
    const { send } = setup({ minutes: 60 });

    expect((await open(send, 'kari')).status).toBe(403);
    expect((await open(send, 'operator', other, 600)).status).toBe(422);
  });
});

describe('effective settings and platform defaults', () => {
  it('explains each value with its winning layer, what it overrode and the pinned version', async () => {
    const { send, publish } = setup();
    await publish('kari', klarsprak({ settings: { 'search.topK': 20 } }));
    await send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
      method: 'PUT',
      body: { value: 50 },
      reason: 'x er nødvendig nå',
    });

    const forService = await body<Record<string, Json>>(
      await send(`/tenants/${digdir}/settings/effective?service=klarsprak`, 'kari'),
    );
    const forTenant = await body<Record<string, Json>>(
      await send(`/tenants/${digdir}/settings/effective`, 'kari'),
    );

    expect(forService['search.topK']).toMatchObject({
      value: 20,
      source: 'service',
      defaultVersion: 1,
      overridden: [
        { layer: 'default', value: 100 },
        { layer: 'tenant', value: 50 },
      ],
    });
    expect(forTenant['search.topK']).toMatchObject({ value: 50, source: 'tenant' });
    expect(
      (await send(`/tenants/${digdir}/settings/effective?service=finnes-ikke`, 'kari')).status,
    ).toBe(404);
  });

  it('refuses a service setting the platform does not define at publish', async () => {
    const { publish } = setup();

    const res = await publish('kari', klarsprak({ settings: { 'search.colour': 'red' } }));

    expect(res.status).toBe(422);
    expect((await body<{ errors: { path: string }[] }>(res)).errors.map((e) => e.path)).toEqual([
      'spec.settings.search.colour',
    ]);
  });

  it('previews a tenant change with before, after and the services it reaches, without applying it', async () => {
    const { send, publish } = setup();
    await publish('kari', klarsprak());
    await publish(
      'kari',
      klarsprak({
        id: 'ka',
        variants: [{ id: 'default', publicName: 'ka' }],
        settings: { 'search.topK': 5 },
      }),
    );

    const res = await send(`/tenants/${digdir}/settings/search.topK?dryRun=true`, 'kari', {
      method: 'PUT',
      body: { value: 25 },
      reason: 'prøve en ny verdi',
    });

    expect(await body(res)).toMatchObject({
      dryRun: true,
      tenant: { before: 100, after: 25 },
      services: [
        { service: 'klarsprak', status: 'changes', before: 100, after: 25 },
        { service: 'ka', status: 'overridden', before: 5, after: 5 },
      ],
    });
    expect(await body(await send(`/tenants/${digdir}/settings`, 'kari'))).toEqual({
      values: {},
      pins: {},
    });
    expect(await listed(await send(`/tenants/${digdir}/audit`, 'kari'))).toHaveLength(2);
  });

  it('lets operators change a default, shows which services change and which are pinned, and keeps a changelog', async () => {
    const { send, publish, admin } = setup();
    await publish('kari', klarsprak());
    await publish(
      'ola',
      klarsprak({ tenant: other, id: 'annen', variants: [{ id: 'default', publicName: 'annen' }] }),
    );
    await send(`/tenants/${other}/pins/search.topK`, 'ola', {
      method: 'PUT',
      body: { version: 1 },
      reason: 'stabil versjon nå',
    });
    const change = (who: string, query = '') =>
      send(`/settings/defaults/search.topK${query}`, who, {
        method: 'PUT',
        body: { value: 60 },
        reason: 'færre treff',
      });

    expect((await change('kari')).status).toBe(403);
    const preview = await body<{ services: Json[] }>(await change('operator', '?dryRun=true'));
    expect(preview.services.map((s) => [s.tenant, s.service, s.status])).toEqual([
      [digdir, 'klarsprak', 'changes'],
      [other, 'annen', 'pinned'],
    ]);
    const applied = await change('operator');
    expect(applied.status).toBe(200);

    expect(await listed(await send('/settings/defaults/search.topK/changelog', 'kari'))).toEqual([
      {
        key: 'search.topK',
        version: 2,
        value: 60,
        changedAt: '2026-10-06T10:00:00.000Z',
        changedBy: 'operator:test:drift',
        reason: 'færre treff',
      },
    ]);
    const audit = await admin.audit(digdir);
    expect(audit.at(-1)).toMatchObject({
      action: 'platform.default.set',
      actor: 'operator:test:drift',
    });
    expect(
      (await body<Record<string, Json>>(await send(`/tenants/${other}/settings/effective`, 'ola')))[
        'search.topK'
      ],
    ).toMatchObject({
      value: 100,
      source: 'pin',
      pinnedVersion: 1,
    });
  });

  it('lists setting definitions and current defaults', async () => {
    const { send } = setup();

    const definitions = await listed<{ key: string }>(await send('/settings', 'kari'));
    const defaults = await listed<{ key: string; version: number }>(
      await send('/settings/defaults', 'kari'),
    );

    expect(definitions.map((d) => d.key)).toEqual(['search.topK', 'tools.lovdata.key']);
    expect((definitions[0] as { schema?: Json }).schema).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 200,
    });
    expect(defaults.map((d) => [d.key, d.version])).toEqual([
      ['search.topK', 1],
      ['tools.lovdata.key', 1],
    ]);
  });
});

describe('export and import', () => {
  it('exports a tenant with prompt files and secret references, then clones it into another tenant after a dry run', async () => {
    const { send, publish, store } = setup();
    await publish(
      'kari',
      klarsprak({ variants: [{ id: 'default', publicName: 'klarsprak-digdir' }] }),
    );
    await send(`/tenants/${digdir}/settings/tools.lovdata.key`, 'kari', {
      method: 'PUT',
      body: { value: 'secret://991825827/lovdata' },
      reason: 'nøkkel til tjenesten',
    });

    const bundle = await body<{ definitions: { definition: Json; files: Json }[]; settings: Json }>(
      await send(`/tenants/${digdir}/export`, 'kari'),
    );
    expect(bundle.definitions[0]?.files).toEqual(files);
    expect(bundle.settings).toEqual({
      values: { 'tools.lovdata.key': 'secret://991825827/lovdata' },
      pins: {},
    });

    const forOther = {
      ...bundle,
      definitions: bundle.definitions.map((d) => ({
        ...d,
        definition: {
          ...d.definition,
          spec: {
            ...(d.definition.spec as Json),
            variants: [{ id: 'default', publicName: 'klarsprak-annen' }],
          },
        },
      })),
    };
    const dry = await send(`/tenants/${other}/import?dryRun=true`, 'ola', {
      body: forOther,
      reason: 'kloning av virksomheten',
    });
    expect(await body(dry)).toMatchObject({
      dryRun: true,
      plan: [
        { target: 'Service:klarsprak', action: 'create', conflict: false },
        { target: 'setting:tools.lovdata.key', action: 'create', conflict: false },
      ],
    });
    expect(await store.list(other)).toEqual([]);

    const real = await send(`/tenants/${other}/import`, 'ola', {
      body: forOther,
      reason: 'kloning av virksomheten',
    });
    expect(real.status).toBe(200);
    expect((await store.get('Service', other, 'klarsprak'))?.publishedBy).toBe('employee:test:ola');
    const audit = await listed<{ action: string }>(await send(`/tenants/${other}/audit`, 'ola'));
    expect(audit.map((a) => a.action)).toEqual(['platform.tenant.import']);
  });

  it('import applies the risk confirmation rule and records the importing person as confirmer', async () => {
    const { send, publish, store } = setup();
    await publish('kari', klarsprak());
    const bundle = await body<{ definitions: { definition: Json; files: Json }[] }>(
      await send(`/tenants/${digdir}/export`, 'kari'),
    );
    const withRisk = (riskConfirmation?: Json) => ({
      ...bundle,
      definitions: bundle.definitions.map((d) => ({
        ...d,
        definition: {
          ...d.definition,
          spec: {
            ...(d.definition.spec as Json),
            variants: [{ id: 'default', publicName: 'klarsprak-annen' }],
            riskClass: 'limited',
            ...(riskConfirmation ? { riskConfirmation } : {}),
          },
        },
      })),
    });
    const reason = 'kloning av virksomheten';

    const dryUnconfirmed = await send(`/tenants/${other}/import?dryRun=true`, 'ola', {
      body: withRisk(),
      reason,
    });
    const unconfirmed = await send(`/tenants/${other}/import`, 'ola', { body: withRisk(), reason });
    const confirmed = await send(`/tenants/${other}/import`, 'ola', {
      body: withRisk({
        reasons: ['Svarer innbyggere'],
        by: 'employee:test:someone-else',
        at: '2020-01-01T00:00:00.000Z',
      }),
      reason,
    });

    expect(dryUnconfirmed.status).toBe(422);
    expect(unconfirmed.status).toBe(422);
    expect(await unconfirmed.json()).toMatchObject({
      errors: [{ path: 'Service:klarsprak.spec.riskConfirmation' }],
    });
    expect(confirmed.status).toBe(200);
    const stored = (await store.get('Service', other, 'klarsprak'))?.definition as {
      spec: { riskConfirmation: Json };
    };
    expect(stored.spec.riskConfirmation).toMatchObject({
      by: 'employee:test:ola',
      riskClass: 'limited',
      reasons: ['Svarer innbyggere'],
    });
    expect(stored.spec.riskConfirmation.at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('refuses a bundle with a plain secret and reports conflicts according to the choice', async () => {
    const { send, publish } = setup();
    await publish('kari', klarsprak());
    await send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
      method: 'PUT',
      body: { value: 30 },
      reason: 'x er nødvendig nå',
    });
    const bundle = await body<Json>(await send(`/tenants/${digdir}/export`, 'kari'));
    await send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
      method: 'PUT',
      body: { value: 70 },
      reason: 'y er nødvendig nå',
    });

    const plain = await send(`/tenants/${digdir}/import`, 'kari', {
      body: { ...bundle, settings: { values: { 'tools.lovdata.key': 'sk-123' }, pins: {} } },
      reason: 'z er nødvendig nå',
    });
    const skip = await send(`/tenants/${digdir}/import?dryRun=true&onConflict=skip`, 'kari', {
      body: bundle,
      reason: 'z er nødvendig nå',
    });

    expect(plain.status).toBe(422);
    expect((await body<{ plan: Json[] }>(skip)).plan).toEqual([
      { target: 'Service:klarsprak', action: 'unchanged', conflict: false },
      { target: 'setting:search.topK', action: 'skip', conflict: true },
    ]);
    expect(
      (
        await send(`/tenants/${other}/import`, 'kari', {
          body: bundle,
          reason: 'z er nødvendig nå',
        })
      ).status,
    ).toBe(404);
  });
});

describe('task timeline and the operator tenant list', () => {
  it("shows a task's status, numbers and steps to its own tenant, from client events only", async () => {
    const { send, publish } = setup();
    const task = (await publish('kari', klarsprak())).headers.get('genai-task');

    const res = await send(`/tenants/${digdir}/tasks/${task}/timeline`, 'kari');

    expect(res.status).toBe(200);
    const timeline = await body<{ steps: { type: string; blocks: Json[] }[] } & Json>(res);
    expect(timeline).toMatchObject({
      id: task,
      service: 'platform.service.publish',
      status: 'completed',
      trigger: 'api',
      caller: 'employee',
      inputTokens: 0,
      costOre: 0,
    });
    expect(timeline.steps.map((s) => s.type)).toEqual(['trigger', 'result']);
    expect(JSON.stringify(timeline)).not.toContain('x.platform.change');
    expect((await send(`/tenants/${other}/tasks/${task}/timeline`, 'ola')).status).toBe(404);
    expect((await send(`/tenants/${digdir}/tasks/${task}/timeline`, 'ola')).status).toBe(404);
    expect((await send(`/tenants/${digdir}/tasks/finnes-ikke/timeline`, 'kari')).status).toBe(404);
  });

  it('shows tokens and cost on a timeline only with view-usage or to the person who started the task', async () => {
    Object.assign(principals, {
      tove: {
        kind: 'employee',
        issuer: 'test',
        subject: 'tove',
        tenant: digdir,
        authorizedFor: [{ org: digdir, actions: ['use-services', 'manage-services'] }],
      },
    });
    const { send, publish } = setup();
    const byKari = (await publish('kari', klarsprak())).headers.get('genai-task');
    const byTove = (await publish('tove', klarsprak({ id: 'klarsprak-to' }))).headers.get(
      'genai-task',
    );

    const notOwn = await body<Json>(
      await send(`/tenants/${digdir}/tasks/${byKari}/timeline`, 'tove'),
    );
    const own = await body<Json>(await send(`/tenants/${digdir}/tasks/${byTove}/timeline`, 'tove'));

    for (const field of ['inputTokens', 'outputTokens', 'costOre'])
      expect(notOwn).not.toHaveProperty(field);
    expect(notOwn.stats).not.toHaveProperty('inputTokens');
    expect(notOwn.stats).not.toHaveProperty('byModel');
    expect(own).toMatchObject({ inputTokens: 0, costOre: 0 });
  });

  it('names the service on the timeline, a playground draft as Prøveområdet and a builder assistant run as Byggeassistenten, in the asked language', async () => {
    const { store, admin, settings } = setup();
    await store.publish(klarsprak(), 'test', 'seed', files);
    const descriptor = (await store.capabilities())[0]?.capability.descriptor;
    const taskOf = (id: string, capability: string) =>
      ({
        id,
        tenant: digdir,
        service: { capability: { id: capability, version: '1' } },
        status: 'completed',
        principal: { kind: 'employee', id: JSON.stringify(['test', 'kari']) },
        createdAt: '2026-10-06T10:00:00.000Z',
        endedAt: '2026-10-06T10:00:01.000Z',
        usage: {},
      }) as unknown as Task;
    const tasks: Record<string, Task> = {
      t1: taskOf('t1', descriptor?.id ?? ''),
      t2: taskOf('t2', 'platform/draft/playground/abc'),
      t3: taskOf('t3', 'platform/draft/assistant/def'),
    };
    const app = createApp('test', {
      platform: {
        store,
        plugins,
        settings,
        auth,
        admin,
        tasks: { task: async (id) => tasks[id], events: async () => [] },
      },
    });
    const read = async (id: string, language = 'nb') =>
      body(
        await app.request(`/tenants/${digdir}/tasks/${id}/timeline`, {
          headers: { authorization: 'Bearer kari', 'accept-language': language },
        }),
      );

    expect(descriptor?.title).toBeTruthy();
    expect(await read('t1')).toMatchObject({ serviceName: descriptor?.title });
    expect(await read('t2')).toMatchObject({ serviceName: 'Prøveområdet (utkast)' });
    expect(await read('t3')).toMatchObject({ serviceName: 'Byggeassistenten' });
    expect(await read('t3', 'en')).toMatchObject({ serviceName: 'The builder assistant' });
  });

  it('shows operators every tenant value and service value on top of the defaults', async () => {
    const { send, publish } = setup();
    await publish('kari', klarsprak({ settings: { 'search.topK': 20 } }));
    await send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
      method: 'PUT',
      body: { value: 40 },
      reason: 'færre treff',
    });

    expect((await send('/operator/settings/overrides', 'kari')).status).toBe(403);
    const overrides = await body<{
      tenants: Record<string, { values: Json }>;
      services: { tenant: string; service: string; settings: Json }[];
    }>(await send('/operator/settings/overrides', 'operator'));
    expect(overrides.tenants[digdir]?.values).toEqual({ 'search.topK': 40 });
    expect(overrides.tenants[other]?.values).toEqual({});
    expect(overrides.services).toEqual([
      expect.objectContaining({
        tenant: digdir,
        service: 'klarsprak',
        settings: { 'search.topK': 20 },
      }),
    ]);
  });

  it('lists every tenant with its service count for operators only', async () => {
    const { send, publish } = setup();
    await publish('kari', klarsprak());

    expect((await send('/operator/tenants', 'kari')).status).toBe(403);
    expect(await listed(await send('/operator/tenants', 'operator'))).toEqual([
      { orgNumber: digdir, name: digdir, status: 'active', services: 1, quotaUsedPercent: 0 },
      {
        orgNumber: other,
        name: 'Testetaten',
        status: 'onboarding',
        services: 0,
        quotaUsedPercent: 0,
      },
    ]);
  });

  it('names a tenant outside the directory after its known organisation instead of its org number', async () => {
    const { send, publish } = setup({
      organisationName: (org) => (org === digdir ? 'Digitaliseringsdirektoratet' : undefined),
    });
    await publish('kari', klarsprak());

    const tenants = await listed<{ orgNumber: string; name: string }>(
      await send('/operator/tenants', 'operator'),
    );

    expect(tenants.find((t) => t.orgNumber === digdir)?.name).toBe('Digitaliseringsdirektoratet');
    expect(tenants.find((t) => t.orgNumber === other)?.name).toBe('Testetaten');
  });

  it('leaves an archived service out of the tenant service count', async () => {
    const { send, publish } = setup({ lifecycle: async () => ({ state: 'archived' }) });
    await publish('kari', klarsprak());

    const tenants = await listed<{ orgNumber: string; services: number }>(
      await send('/operator/tenants', 'operator'),
    );

    expect(tenants.find((t) => t.orgNumber === digdir)?.services).toBe(0);
  });

  it('shows how much of its monthly token quota each tenant has used', async () => {
    const used: Record<string, number> = { [digdir]: 1_500, [other]: 0 };
    const { send, publish } = setup({
      tenantQuota: async (tenant) => ({ usedPercent: ((used[tenant] ?? 0) / 10_000) * 100 }),
    });
    await publish('kari', klarsprak());

    const tenants = await listed<{ orgNumber: string; quotaUsedPercent: number }>(
      await send('/operator/tenants', 'operator'),
    );

    expect(tenants.map((t) => [t.orgNumber, t.quotaUsedPercent])).toEqual([
      [digdir, 15],
      [other, 0],
    ]);
  });

  it('describes the admin routes in the OpenAPI document', async () => {
    const { send } = setup();

    const doc = await body<{ paths: Record<string, unknown> }>(
      await send('/openapi.json', undefined),
    );

    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/settings',
        '/settings/defaults',
        '/settings/defaults/{key}',
        '/settings/defaults/{key}/changelog',
        '/tenants/{tenant}/settings',
        '/tenants/{tenant}/settings/effective',
        '/tenants/{tenant}/settings/{key}',
        '/tenants/{tenant}/pins/{key}',
        '/tenants/{tenant}/export',
        '/tenants/{tenant}/import',
        '/support-sessions',
        '/tenants/{tenant}/audit',
        '/tenants/{tenant}/audit/{task}',
        '/tenants/{tenant}/tasks/{task}/timeline',
        '/operator/tenants',
      ]),
    );
  });
});

describe("a tenant's change list", () => {
  it('leaves out operator actions that did not change the tenant, though the platform log keeps them', async () => {
    const { send, publish, admin } = setup();
    await publish('kari', klarsprak());
    const changed = await send('/settings/defaults/search.topK', 'operator', {
      method: 'PUT',
      body: { value: 30 },
      reason: 'ny plattformstandard',
    });
    expect(changed.status).toBe(200);

    const asTenant = await listed<{ action: string }>(
      await send(`/tenants/${digdir}/audit`, 'kari'),
    );
    expect(asTenant.map((a) => a.action)).toEqual(['platform.service.publish']);
    expect((await admin.audit(digdir)).map((a) => a.action)).toContain('platform.default.set');
  });

  it("names the person who made a change when the API knows the person's name", async () => {
    const { send } = setup();
    await send('/definitions', 'kari', {
      body: { definition: klarsprak(), files },
      reason: 'første versjon',
      name: 'Kari Nordmann',
    });

    const audit = await listed<{ actor: string; actorName?: string }>(
      await send(`/tenants/${digdir}/audit`, 'kari'),
    );
    expect(audit[0]).toMatchObject({ actor: 'employee:test:kari', actorName: 'Kari Nordmann' });
  });
});
