import { Hono } from 'hono';
import type { ZodType } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { hookSpec } from '@genai/hooks';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { webhookHookSender, type HookSender } from './hooks.js';
import { hookRoutes } from './hooks-openapi.js';
import { bootPlatform, digdir, files, other, readJson as json, testService } from './testkit.js';
import { verifyWebhookSignature } from './webhooks.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  bruker: {
    kind: 'employee',
    issuer: 'test',
    subject: 'bruker',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: other,
    authorizedFor: [{ org: other }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const blockTerms = (terms: string[], extra: Record<string, unknown> = {}) => ({
  name: 'Stopp hemmeligheter',
  point: 'before_model',
  mode: 'enforce',
  handler: { kind: 'builtin', id: 'block-terms', config: { terms } },
  ...extra,
});

describe('hooks API', () => {
  it('lets a tenant save, list, test and delete its hooks, audited with a reason', async () => {
    const { send } = await bootPlatform({ people });
    const path = `/tenants/${digdir}/hooks/hemmelig`;
    const saved = await send(path, 'kari', {
      method: 'PUT',
      body: blockTerms(['Hei']),
      reason: 'Ikke send hemmeligheter til modellen',
    });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('genai-task')).toBeTruthy();
    expect(await json(saved)).toMatchObject({ id: 'hemmelig', version: 1, failure: 'open' });

    const listed = await json<{
      data: { id: string; changedBy: string }[];
      builtins: { id: string }[];
    }>(await send(`/tenants/${digdir}/hooks`, 'kari'));
    expect(listed.data.map((h) => h.id)).toEqual(['hemmelig']);
    expect(listed.builtins.map((b) => b.id)).toContain('block-terms');

    const tried = await json<{ refused?: { reason: string } }>(
      await send(`${path}/test`, 'kari', { method: 'POST' }),
    );
    expect(tried.refused?.reason).toBe('teksten inneholder «Hei»');

    expect((await send(path, 'kari', { method: 'DELETE', reason: 'Trengs ikke' })).status).toBe(
      200,
    );
    expect((await send(path, 'kari', { method: 'DELETE', reason: 'Trengs ikke' })).status).toBe(
      404,
    );
  });

  it('checks the hook, the reason and the right', async () => {
    const { send } = await bootPlatform({ people });
    const path = `/tenants/${digdir}/hooks/krok`;
    const put = (body: unknown, as = 'kari', reason = 'Ny krok for testen') =>
      send(path, as, { method: 'PUT', body, reason });
    expect((await put(blockTerms(['x'], { mode: 'observe', failure: 'closed' }))).status).toBe(400);
    expect(
      (
        await put({
          ...blockTerms([]),
          handler: { kind: 'builtin', id: 'block-terms', config: { terms: [] } },
        })
      ).status,
    ).toBe(400);
    expect((await put(blockTerms(['x']), 'kari', '')).status).toBe(400);
    expect((await put(blockTerms(['x']), 'bruker')).status).toBe(403);
    expect((await put(blockTerms(['x']), 'ola')).status).toBe(404);
    expect(
      (
        await send(`/tenants/${digdir}/hooks/Ugyldig Id`, 'kari', {
          method: 'PUT',
          body: blockTerms(['x']),
          reason: 'Ugyldig id i testen',
        })
      ).status,
    ).toBe(400);
  });

  it('keeps platform hooks for operators and shows them to tenants', async () => {
    const { send } = await bootPlatform({ people });
    const put = (as: string) =>
      send('/operator/hooks/plattform-ord', as, {
        method: 'PUT',
        body: blockTerms(['passord']),
        reason: 'Felles regel for alle',
      });
    expect((await put('kari')).status).toBe(403);
    expect((await put('drift')).status).toBe(200);
    const seen = await json<{ platform: { id: string; scope: string }[] }>(
      await send(`/tenants/${digdir}/hooks`, 'bruker'),
    );
    expect(seen.platform).toMatchObject([{ id: 'plattform-ord', scope: 'platform' }]);
  });

  it('stops a publish that an on_publish hook refuses', async () => {
    const { send, platform } = await bootPlatform({ people });
    await send(`/tenants/${digdir}/hooks/publisering`, 'kari', {
      method: 'PUT',
      body: blockTerms(['ny-tjeneste'], { point: 'on_publish', name: 'Navnesjekk' }),
      reason: 'Ingen tjenester med det navnet',
    });
    const published = await platform.definitions.publish(
      testService('ny-tjeneste'),
      'kari',
      'første versjon',
      files,
    );
    expect(published).toMatchObject({
      ok: false,
      errors: [
        { path: 'hooks', message: expect.stringContaining('Stoppet av kroken «Navnesjekk»') },
      ],
    });
    expect(
      await platform.definitions.publish(testService('annen'), 'kari', 'første versjon', files),
    ).toMatchObject({ ok: true });
  });
});

describe('webhook hooks', () => {
  it('sign the call and read the verdict, and treat other answers as failures', async () => {
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    let answer = { status: 200, body: '{"decision":"refuse","reason":"nei"}' };
    const send: HookSender = async (url, init) => {
      sent.push({ url, ...init });
      return answer;
    };
    const hook = {
      id: 'mottaker',
      scope: digdir,
      ...hookSpec.parse({
        name: 'Mottaker',
        point: 'before_tool',
        mode: 'enforce',
        handler: { kind: 'webhook', url: 'https://krok.example.no/inn', secret: 'krok' },
      }),
    } as Parameters<ReturnType<typeof webhookHookSender>>[0];
    const sender = webhookHookSender({
      secrets: { resolve: async (ref) => (ref === `secret://tenant/${digdir}/krok` ? 's3' : '') },
      send,
      newId: () => 'levering-1',
    });
    const call = {
      point: 'before_tool' as const,
      tenant: digdir,
      task: 't1',
      payload: { tool: 'finn' },
    };
    expect(await sender(hook, call, new AbortController().signal)).toEqual({
      decision: 'refuse',
      reason: 'nei',
    });
    expect(sent[0]?.url).toBe('https://krok.example.no/inn');
    expect(sent[0]?.headers['genai-event']).toBe('hook.before_tool');
    expect(
      verifyWebhookSignature('s3', sent[0]?.headers['genai-signature'] ?? '', sent[0]?.body ?? ''),
    ).toBe(true);
    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({
      id: 'levering-1',
      hook: 'mottaker',
      payload: { tool: 'finn' },
    });
    answer = { status: 500, body: '' };
    await expect(sender(hook, call, new AbortController().signal)).rejects.toThrow('HTTP 500');
    answer = { status: 200, body: '{"decision":"kanskje"}' };
    await expect(sender(hook, call, new AbortController().signal)).rejects.toThrow(
      'unknown verdict',
    );
  });
});

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((s) => s.close()));
});

describe('hooks in a run', () => {
  const boot = async () => {
    const model = await fakeHttp(() => ({
      status: 200,
      json: {
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Vurdert.' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    }));
    fakes.push(model);
    const delivered: { event: string; body: Record<string, unknown> }[] = [];
    const store = new InMemoryConfigEntryStore();
    const platform = await createPlatform({
      catalogs: {
        models: {
          endpoints: {
            fake: {
              protocol: 'openai-chat',
              baseURL: `${model.url}/v1`,
              auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
            },
          },
          models: [{ id: 'fake/gpt', endpoint: 'fake', deployment: 'gpt', residency: 'norway' }],
        },
        knowledge: { endpoints: {}, datasets: [] },
        rerank: { endpoints: {}, rerankers: [] },
      },
      secrets: envSecrets({ FAKE_KEY: 'k' }),
      definitions: (p) => new InMemoryDefinitionStore(p),
      configurables: { store, scheduleIntervalMs: 0 },
      policy: { decide: async () => ({ allow: true }) },
      egress: { testOverride: { allowLoopback: true, allowHttp: true }, timeoutMs: 2000 },
      hookSender: async (_url, init) => {
        delivered.push({
          event: init.headers['genai-event'] ?? '',
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return { status: 200, body: '{"annotations":{"sjekket":true}}' };
      },
      authenticate: async (request) =>
        request.headers.get('authorization') === 'Bearer kari'
          ? { principal: people.kari as Principal }
          : undefined,
    });
    expect(
      await platform.definitions.publish(testService('svar'), 'test', 'test', files),
    ).toMatchObject({
      ok: true,
    });
    const admin = createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      extensions: platform.extensions,
    });
    const app = new Hono();
    platform.mount(app, admin);
    const send = (path: string, body?: unknown, method?: string, reason?: string) =>
      app.request(path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          authorization: 'Bearer kari',
          'content-type': 'application/json',
          ...(reason ? { 'change-reason': reason } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { send, model, delivered };
  };

  it('refuses the model call when an enforcing hook says no, before anything reaches the model', async () => {
    const { send, model } = await boot();
    const saved = await send(
      `/tenants/${digdir}/hooks/hemmelig`,
      blockTerms(['hemmelig']),
      'PUT',
      'Ikke send hemmeligheter',
    );
    expect(saved.status).toBe(200);
    const refused = await send('/api/tools/call/svar__default', { query: 'Dette er hemmelig' });
    expect(await refused.json()).toMatchObject({ status: 'error' });
    expect(model.seen).toHaveLength(0);
    const allowed = await send('/api/tools/call/svar__default', { query: 'Hva er fristen?' });
    expect(await allowed.json()).toMatchObject({ answer: 'Vurdert.' });
    expect(model.seen).toHaveLength(1);
  });

  it('sends signed webhook calls after the model and when the task completes', async () => {
    const { send, delivered } = await boot();
    const secret = await send(
      `/tenants/${digdir}/secrets/krok`,
      { value: 's3' },
      'PUT',
      'Krok for varsler',
    );
    expect(secret.status).toBe(200);
    for (const [id, point] of [
      ['etter-modell', 'after_model'],
      ['ferdig', 'task_completed'],
    ] as const)
      await send(
        `/tenants/${digdir}/hooks/${id}`,
        {
          name: id,
          point,
          mode: 'annotate',
          handler: { kind: 'webhook', url: 'https://krok.example.no/inn', secret: 'krok' },
        },
        'PUT',
        'Følg med på svarene',
      );
    const answered = await send('/api/tools/call/svar__default', { query: 'Hva er fristen?' });
    expect(answered.status).toBe(200);
    expect(delivered.map((d) => d.event)).toEqual(['hook.after_model', 'hook.task_completed']);
    expect(delivered[0]?.body).toMatchObject({
      point: 'after_model',
      tenant: digdir,
      payload: { content: 'Vurdert.' },
    });
  });

  it('sends feedback on an answer to on_feedback hooks of the tenant that owns the service', async () => {
    const { send, delivered } = await boot();
    await send(`/tenants/${digdir}/secrets/krok`, { value: 's3' }, 'PUT', 'Krok for varsler');
    await send(
      `/tenants/${digdir}/hooks/tilbakemelding`,
      {
        name: 'Tilbakemelding',
        point: 'on_feedback',
        mode: 'observe',
        handler: { kind: 'webhook', url: 'https://krok.example.no/inn', secret: 'krok' },
      },
      'PUT',
      'Send tilbakemeldinger til saksbehandling',
    );
    const answered = await send('/api/tools/call/svar__default', { query: 'Hva er fristen?' });
    const task = answered.headers.get('genai-task') ?? '';
    const given = await send(`/tasks/${task}/feedback`, {
      rating: 'down',
      reasons: ['Feil frist'],
    });
    expect(given.status).toBe(201);
    for (let i = 0; i < 50 && !delivered.some((d) => d.event === 'hook.on_feedback'); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(delivered.find((d) => d.event === 'hook.on_feedback')?.body).toMatchObject({
      point: 'on_feedback',
      tenant: digdir,
      payload: { task, rating: 'down', reasons: ['Feil frist'] },
    });
  });
});

describe('hooks in the API document and the change log', () => {
  it('answers the tenant hook routes with exactly the documented shapes', async () => {
    const { send } = await bootPlatform({ people });
    const base = `/tenants/${digdir}/hooks`;
    const reason = 'Ikke send hemmeligheter til modellen';
    const schema = (method: string, path: string) => {
      const route = hookRoutes.find((r) => r.method === method && r.path === path);
      const content = route?.responses[200] as
        { content: { 'application/json': { schema: ZodType } } } | undefined;
      if (!content) throw new Error(`${method} ${path} is not documented`);
      return content.content['application/json'].schema;
    };
    const conforms = async (res: Response, method: string, path: string) => {
      expect(res.status, `${method} ${path}`).toBe(200);
      expect(schema(method, path).safeParse(await res.json()).error).toBeUndefined();
    };

    await conforms(
      await send(`${base}/hemmelig`, 'kari', { method: 'PUT', body: blockTerms(['Hei']), reason }),
      'put',
      '/tenants/{tenant}/hooks/{id}',
    );
    await conforms(await send(base, 'kari'), 'get', '/tenants/{tenant}/hooks');
    await conforms(
      await send(`${base}/hemmelig/test`, 'kari', { body: {} }),
      'post',
      '/tenants/{tenant}/hooks/{id}/test',
    );
    await conforms(
      await send(`${base}/hemmelig`, 'kari', { method: 'DELETE', reason }),
      'delete',
      '/tenants/{tenant}/hooks/{id}',
    );
  });

  it('lists the tenant hook routes in the OpenAPI document', async () => {
    const { send } = await bootPlatform({ people });
    const doc = await json<{ paths: Record<string, Record<string, unknown>> }>(
      await send('/openapi.json', 'kari'),
    );
    expect(Object.keys(doc.paths['/tenants/{tenant}/hooks'] ?? {})).toEqual(['get']);
    expect(Object.keys(doc.paths['/tenants/{tenant}/hooks/{id}'] ?? {}).sort()).toEqual([
      'delete',
      'put',
    ]);
    expect(doc.paths['/tenants/{tenant}/hooks/{id}/test']).toHaveProperty('post');
  });

  it('records on_publish hook runs in the audit log also when they let the publish through', async () => {
    const { send, platform, admin } = await bootPlatform({ people });
    await send(`/tenants/${digdir}/hooks/merk-publisering`, 'kari', {
      method: 'PUT',
      body: {
        name: 'Merk publisering',
        point: 'on_publish',
        mode: 'annotate',
        handler: { kind: 'builtin', id: 'tag', config: { labels: { kilde: 'portal' } } },
      },
      reason: 'Vil se publiseringene i loggen',
    });
    expect(
      await platform.definitions.publish(testService('loggfort'), 'kari', 'første versjon', files),
    ).toMatchObject({ ok: true });
    const entries = await admin.audit(digdir);
    expect(entries.find((e) => e.action === 'platform.hook.publish-check')).toMatchObject({
      outcome: 'applied',
      reason: 'Service loggfort: Merk publisering merket',
    });
  });
});
