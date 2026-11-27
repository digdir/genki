import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { trustedEntraScope } from '@genai/identity';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { translateMessage } from './i18n/index.js';
import { bootPlatform, digdir, readJson } from './testkit.js';

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  entra: { kind: 'operator', issuer: 'test', subject: 'entra', scopes: [trustedEntraScope] },
};

const completion = (content: string) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
});

const knowledge = {
  endpoints: {
    search: {
      engine: 'http-search',
      baseURL: 'http://127.0.0.1:9',
      auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
    },
  },
  datasets: [
    {
      id: 'digdir/kudos',
      endpoint: 'search',
      residency: 'norway',
      options: {},
    },
  ],
};

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const boot = async (options: { lockdown?: boolean } = {}) => {
  const gateway = await fakeHttp((body, _attempt, path) => {
    if (path === '/v1/models')
      return { status: 200, json: { object: 'list', data: [{ id: 'able' }, { id: 'plain' }] } };
    if (body.model === 'able' && body.response_format)
      return { status: 200, json: completion('{"colour":"blue"}') };
    return { status: 200, json: completion('Blue.') };
  });
  servers.push(gateway);
  const booted = await bootPlatform({
    ...options,
    people,
    knowledge,
    models: {
      endpoints: {
        gw: {
          baseURL: `${gateway.url}/v1`,
          auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          families: { openai: '' },
          discovery: [{ source: 'openai-models', capabilities: [] }],
        },
      },
      models: [],
    },
  });
  return { ...booted, gateway };
};

const ragService = (model: string) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: `svar-${model.split('/')[1]}`, name: 'Svar' },
  spec: {
    purpose: 'Svar kort på spørsmål',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'rag-single-shot', version: 1, config: { instructions: 'Svar kort.' } },
    knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
    model: { primary: model, residency: 'global' },
  },
});

describe('genki finds out what a discovered model can do', () => {
  it('the refusal that names what genki checked reads in bokmål', () => {
    expect(
      translateMessage(
        'model gw/plain lacks json-schema, which rag-single-shot needs; checked json-schema on 2026-11-20',
        'nb',
      ),
    ).toBe(
      'Modellen «gw/plain» mangler json-schema, som oppsettet rag-single-shot trenger. Genki sjekket json-schema 2026-11-20.',
    );
  });

  it('a discovered model with no capabilities in its rule that answers in the JSON shape gets json-schema and can run rag-single-shot', async () => {
    const { send, platform } = await boot();

    const refreshed = await send('/operator/models/refresh', 'drift', {
      method: 'POST',
      reason: 'Se hva modellene kan',
    });
    const published = await platform.definitions.publish(ragService('gw/able'), 'test', 'ny');

    expect(refreshed.status).toBe(200);
    expect(
      (await readJson<{ learned: { checked: unknown[] } }>(refreshed)).learned.checked,
    ).toContainEqual({ model: 'gw/able', capability: 'json-schema', has: true });
    expect(published).toMatchObject({ ok: true });
  });

  it('one that does not answer in the JSON shape stays refused, naming what genki checked', async () => {
    const { send, platform } = await boot();

    await send('/operator/models/refresh', 'drift', {
      method: 'POST',
      reason: 'Se hva modellene kan',
    });
    const published = await platform.definitions.publish(ragService('gw/plain'), 'test', 'ny');

    expect(published.ok ? [] : published.errors.map((e) => e.message)).toContainEqual(
      expect.stringMatching(
        /^model gw\/plain lacks json-schema, which rag-single-shot needs; checked json-schema on \d{4}-\d{2}-\d{2}$/,
      ),
    );
  });

  it('the operator model list shows which capabilities were learned and when', async () => {
    const { send } = await boot();

    await send('/operator/models/refresh', 'drift', {
      method: 'POST',
      reason: 'Se hva modellene kan',
    });
    const listed = await readJson<{ data: { id: string; learned?: Record<string, unknown> }[] }>(
      await send('/operator/models', 'drift'),
    );

    expect(listed.data.find((m) => m.id === 'gw/able')?.learned).toMatchObject({
      'json-schema': { has: true, by: 'call', at: expect.any(String) },
    });
  });

  it('the startup capability round is refused in lockdown and records nothing', async () => {
    const { send, platform, gateway } = await boot({ lockdown: true });

    const result = await platform.learnModelCapabilities();
    const listed = await readJson<{ data: { id: string; learned?: Record<string, unknown> }[] }>(
      await send('/operator/models', 'entra'),
    );

    expect(result.checked).toEqual([]);
    expect(gateway.seen.filter((r) => r.path !== '/v1/models')).toEqual([]);
    expect(listed.data.filter((m) => m.learned !== undefined)).toEqual([]);
  });

  it('an operator refresh in lockdown checks capabilities when the operator may use models', async () => {
    const { send } = await boot({ lockdown: true });

    const refreshed = await send('/operator/models/refresh', 'entra', {
      method: 'POST',
      reason: 'Se hva modellene kan',
    });

    expect(refreshed.status).toBe(200);
    expect(
      (await readJson<{ learned: { checked: unknown[] } }>(refreshed)).learned.checked,
    ).toContainEqual({ model: 'gw/able', capability: 'json-schema', has: true });
  });
});
