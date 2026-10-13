import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { digdir } from './testkit.js';

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((s) => s.close()));
});

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: digdir,
  authorizedFor: [{ org: digdir }],
};

const service = (id: string, exposure: Record<string, boolean>) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id, name: `Tjeneste ${id}` },
  spec: {
    purpose: 'Svarer kort på spørsmål',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: 'fake/gpt', residency: 'norway' },
    exposure,
  },
});

const boot = async () => {
  const model = await fakeHttp(() => ({
    status: 200,
    json: {
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'Kort svar.' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  }));
  fakes.push(model);
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
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer kari' ? { principal: kari } : undefined,
  });
  await platform.definitions.publish(service('agent', { a2a: true }), 'test', 'test', {});
  await platform.definitions.publish(service('bare-mcp', { mcp: true }), 'test', 'test', {});
  await platform.definitions.publish(
    service('open', { a2a: true, a2aPublicCard: true }),
    'test',
    'test',
    {},
  );
  await platform.definitions.publish(
    service('card-only', { a2aPublicCard: true }),
    'test',
    'test',
    {},
  );
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const send = (path: string, body?: unknown) =>
    app.request(`https://plattform.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { send, app };
};

describe('services as A2A agents', () => {
  it('lists only services published with the a2a channel', async () => {
    const { send } = await boot();

    const listing = (await (await send('/a2a')).json()) as {
      agents: { name: string; supportedInterfaces: { url: string }[] }[];
    };

    expect(listing.agents.map((a) => a.name)).toEqual(['Tjeneste agent', 'Tjeneste open']);
    expect(listing.agents[0]?.supportedInterfaces[0]?.url).toBe(
      'https://plattform.test/a2a/agent__default',
    );
    expect((await send('/a2a/bare-mcp__default')).status).toBe(404);
  });

  it('answers SendMessage through the kernel with the AI marking', async () => {
    const { send } = await boot();

    const response = await send('/a2a/agent__default', {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hei' }] } },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('genai-generated-by')).toBe('ai');
    expect(response.headers.get('genai-model')).toBe('fake/gpt');
    expect(await response.json()).toMatchObject({
      result: {
        task: {
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [
            { parts: expect.arrayContaining([expect.objectContaining({ text: 'Kort svar.' })]) },
          ],
          metadata: { aiGenerated: true, serviceVersion: 1 },
        },
      },
    });
  });

  it('refuses a caller without credentials', async () => {
    const { app } = await boot();

    const response = await app.request('https://plattform.test/a2a/agent__default', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: {} }),
    });

    expect(response.status).toBe(401);
  });

  it('shows only opted-in A2A services to anonymous discovery, as reduced cards', async () => {
    const { app } = await boot();
    const anonymous = (path: string) => app.request(`https://plattform.test${path}`);

    expect((await anonymous('/a2a/agent__default/.well-known/agent-card.json')).status).toBe(401);
    expect((await anonymous('/a2a/card-only__default/.well-known/agent-card.json')).status).toBe(
      401,
    );
    const listing = (await (await anonymous('/a2a')).json()) as {
      agents: Record<string, unknown>[];
    };
    expect(listing.agents.map((a) => a.name)).toEqual(['Tjeneste open']);
    const card = (await (
      await anonymous('/a2a/open__default/.well-known/agent-card.json')
    ).json()) as Record<string, unknown>;
    expect(card).toMatchObject({
      name: 'Tjeneste open',
      version: '1',
      provider: { organization: expect.any(String) },
      supportedInterfaces: [{ url: 'https://plattform.test/a2a/open__default' }],
    });
    expect(card.capabilities).toEqual({ streaming: true });
    expect(card.skills).toEqual([
      {
        id: 'open__default',
        name: 'Tjeneste open',
        description: card.description,
        tags: ['genai'],
      },
    ]);
    expect(JSON.stringify(card)).not.toMatch(/schema|inputFields|examples|extensions/);
  });

  it('rate limits anonymous discovery by address', async () => {
    const { app } = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1)
      statuses.push(
        (
          await app.request('https://plattform.test/a2a', {
            headers: { 'x-forwarded-for': '203.0.113.9' },
          })
        ).status,
      );

    expect(statuses.filter((s) => s === 200)).toHaveLength(30);
    expect(statuses.at(-1)).toBe(429);
  });
});
