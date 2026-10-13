import { describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { createAdmin, type ModelAdmin, type ModelSummary } from './admin.js';
import { createApp } from './app.js';
import { auth, digdir, plugins, settingDefinitions } from './testkit.js';

const stubModels = () => {
  const models = new Map<string, ModelSummary>([
    [
      'foundry-openai/gpt-4o-2m-tps',
      {
        id: 'foundry-openai/gpt-4o-2m-tps',
        residency: 'global',
        capabilities: ['stream', 'tools', 'json-schema'],
        enabled: true,
      },
    ],
  ]);
  const calls: string[] = [];
  const admin: ModelAdmin = {
    describe: () => [...models.values()].map((m) => structuredClone(m)),
    refresh: async () => {
      calls.push('refresh');
      models.set('foundry-claude/claude-sonnet-5-5', {
        id: 'foundry-claude/claude-sonnet-5-5',
        residency: 'global',
        capabilities: ['stream'],
        enabled: true,
      });
      return { discovered: models.size, failed: [{ endpoint: 'aivar', error: 'listing is down' }] };
    },
    classify: async (id, classification) => {
      calls.push(`classify:${id}`);
      const next = { ...(models.get(id) as ModelSummary), ...classification } as ModelSummary;
      models.set(id, next);
      return structuredClone(next);
    },
  };
  return { admin, calls };
};

const setup = () => {
  const models = stubModels();
  const store = new InMemoryDefinitionStore(plugins);
  const settings = new SettingsRegistry(settingDefinitions);
  const admin = createAdmin({ store, plugins, settings, models: models.admin });
  const app = createApp('test', {
    platform: { store, plugins, settings, auth, admin, models: models.admin },
  });
  const send = (
    path: string,
    who: string,
    init: { method: string; body?: unknown; reason?: string },
  ) =>
    app.request(path, {
      method: init.method,
      headers: {
        authorization: `Bearer ${who}`,
        'content-type': 'application/json',
        ...(init.reason ? { 'change-reason': init.reason } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const auditData = async (task: string | null, type: string) =>
    (await admin.events(String(task))).find((e) => e.type === type)?.data as Record<
      string,
      unknown
    >;
  return { app, admin, models, send, auditData };
};

const gpt = '/operator/models/foundry-openai/gpt-4o-2m-tps';

describe('operator model changes', () => {
  it('classifies a model as an audited platform task with actor, reason, before and after', async () => {
    const { admin, send, auditData } = setup();

    const res = await send(gpt, 'operator', {
      method: 'PATCH',
      body: { residency: 'eu' },
      reason: 'bekreftet EU-datasone',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'foundry-openai/gpt-4o-2m-tps', residency: 'eu' });
    const task = res.headers.get('genai-task');
    expect(await auditData(task, 'x.platform.change')).toMatchObject({
      action: 'platform.models.classify',
      target: 'model:foundry-openai/gpt-4o-2m-tps',
      reason: 'bekreftet EU-datasone',
      scope: 'platform',
      supportSession: 'not required: models are platform-wide, not tenant data',
      before: { residency: 'global', enabled: true },
      after: { residency: 'eu', enabled: true },
    });
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({
        task,
        action: 'platform.models.classify',
        actor: 'operator:test:drift',
        outcome: 'applied',
        reason: 'bekreftet EU-datasone',
      }),
    );
  });

  it('runs a refresh as an audited task and records what was found and what failed', async () => {
    const { send, auditData } = setup();

    const res = await send('/operator/models/refresh', 'operator', {
      method: 'POST',
      reason: 'nye utrullinger i Foundry',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      discovered: 2,
      failed: [{ endpoint: 'aivar', error: 'listing is down' }],
    });
    expect(await auditData(res.headers.get('genai-task'), 'x.platform.change')).toMatchObject({
      action: 'platform.models.refresh',
      reason: 'nye utrullinger i Foundry',
      before: { models: ['foundry-openai/gpt-4o-2m-tps'] },
      after: { models: ['foundry-openai/gpt-4o-2m-tps', 'foundry-claude/claude-sonnet-5-5'] },
      result: { discovered: 2 },
    });
  });

  it('refuses a change without a reason and changes nothing', async () => {
    const { send, models } = setup();

    const classify = await send(gpt, 'operator', {
      method: 'PATCH',
      body: { residency: 'norway' },
    });
    const refresh = await send('/operator/models/refresh', 'operator', { method: 'POST' });

    expect([classify.status, refresh.status]).toEqual([400, 400]);
    expect(models.calls).toEqual([]);
    expect(models.admin.describe()[0]?.residency).toBe('global');
  });

  it('lets an operator mark temperature unsupported and audits the parameter rules with the reason', async () => {
    const { send, auditData } = setup();

    const res = await send(gpt, 'operator', {
      method: 'PATCH',
      body: { parameters: { temperature: { mode: 'unsupported' } } },
      reason: 'modellen avviser temperatur',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      parameters: { temperature: { mode: 'unsupported' } },
    });
    expect(await auditData(res.headers.get('genai-task'), 'x.platform.change')).toMatchObject({
      before: { parameters: {} },
      after: { parameters: { temperature: { mode: 'unsupported' } } },
    });
  });

  it('refuses a fixed parameter value the parameter cannot take', async () => {
    const { send, models } = setup();

    const res = await send(gpt, 'operator', {
      method: 'PATCH',
      body: { parameters: { temperature: { mode: 'fixed', value: 9 } } },
      reason: 'test av endringen',
    });

    expect(res.status).toBe(400);
    expect(models.calls).toEqual([]);
  });

  it('refuses an employee with 403 and records the rejected attempt', async () => {
    const { send, models, admin, auditData } = setup();

    const res = await send(gpt, 'kari', {
      method: 'PATCH',
      body: { enabled: false },
      reason: 'prøver på nytt nå',
    });

    expect(res.status).toBe(403);
    expect(models.calls).toEqual([]);
    expect(await auditData(res.headers.get('genai-task'), 'x.platform.rejected')).toMatchObject({
      action: 'platform.models.classify',
      errors: [{ path: 'principal', message: 'only operators change models' }],
    });
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({ actor: 'employee:test:kari', outcome: 'rejected' }),
    );
  });

  it('answers 404 for an unknown model and records the rejected attempt', async () => {
    const { send, auditData } = setup();

    const res = await send('/operator/models/nowhere/x', 'operator', {
      method: 'PATCH',
      body: { residency: 'eu' },
      reason: 'test av endringen',
    });

    expect(res.status).toBe(404);
    expect(await auditData(res.headers.get('genai-task'), 'x.platform.rejected')).toMatchObject({
      target: 'model:nowhere/x',
      errors: [{ path: 'id', message: 'no model nowhere/x' }],
    });
  });

  it('refuses an invalid body before anything runs', async () => {
    const { send, models } = setup();

    const res = await send(gpt, 'operator', {
      method: 'PATCH',
      body: { residency: 'mars' },
      reason: 'test av endringen',
    });

    expect(res.status).toBe(400);
    expect(models.calls).toEqual([]);
  });

  it('lists every model for operators and describes the routes in the OpenAPI document', async () => {
    const { app, send } = setup();

    expect((await send('/operator/models', 'operator', { method: 'GET' })).status).toBe(200);
    expect((await send('/operator/models', 'kari', { method: 'GET' })).status).toBe(403);
    const doc = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 't', version: '1' } });
    expect(Object.keys(doc.paths ?? {})).toEqual(
      expect.arrayContaining([
        '/operator/models',
        '/operator/models/refresh',
        '/operator/models/{id}',
      ]),
    );
  });
});
