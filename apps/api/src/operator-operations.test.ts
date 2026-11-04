import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { syntheticNationalId } from '@genai/kernel/gate-contract';
import { descriptorRegistry, loadDescriptors, parseDescriptor } from '@genai/operations';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { bootPlatform, digdir } from './testkit.js';

const classify = parseDescriptor(`
id: example/classify@1
operation: classify
status: review
summary: A made-up classification API, to try a new kind.
api:
  protocol: openai-chat
  version: 2026-10-01
request:
  method: POST
  path: /classifications
  body:
    model: $deployment
    text: $input.text
input:
  object:
    text: text
output:
  object:
    label: plain
wire:
  request:
    object:
      model: plain
      text: text
  response:
    object:
      label: plain
      usage: { object: { input_tokens: { number: { integer: true, min: 0 } } } }
result:
  label: $response.label
usage:
  inputTokens: $response.usage.input_tokens
  requests: 1
stream: none
`);

const descriptors = descriptorRegistry([...loadDescriptors().list(), classify]);

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

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const boot = async (environmentTier?: 'test' | 'production', lockdown = false) => {
  const server = await fakeHttp(() => ({
    status: 200,
    json: { label: 'billing', usage: { input_tokens: 7 }, id: 'cls_1' },
  }));
  servers.push(server);
  const booted = await bootPlatform({
    people,
    descriptors,
    lockdown,
    ...(environmentTier ? { environmentTier } : {}),
    models: {
      endpoints: {
        lab: {
          protocol: 'openai-chat',
          baseURL: `${server.url}/v1`,
          auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
        },
      },
      models: [
        {
          id: 'lab/small',
          endpoint: 'lab',
          deployment: 'small',
          residency: 'norway',
          operations: ['chat', 'classify'],
        },
      ],
    },
  });
  return { ...booted, server };
};

const reason = 'Prøver et nytt API på syntetiske data';
const path = '/operator/operations/example/classify@1/try';

describe('the raw tier', () => {
  it('a raw descriptor call is refused outside test', async () => {
    const { send, server } = await boot();
    const response = await send(path, 'drift', {
      body: { model: 'lab/small', input: { text: 'hei' }, synthetic: true },
      reason,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'environment' }] });
    expect(server.seen).toEqual([]);
  });

  it('only an operator may try a descriptor in review', async () => {
    const { send, server } = await boot('test');
    const body = { model: 'lab/small', input: { text: 'hei' }, synthetic: true };
    expect((await send(path, 'kari', { body, reason })).status).toBe(403);
    expect(server.seen).toEqual([]);
    const tried = await send(path, 'drift', { body, reason });
    expect(tried.status).toBe(200);
    expect(await tried.json()).toMatchObject({
      descriptor: 'example/classify@1',
      model: 'lab/small',
      result: { label: 'billing' },
    });
  });

  it('a raw descriptor call is refused in lockdown for an operator whose login is not admitted', async () => {
    const { send, server } = await boot('test', true);
    const response = await send(path, 'drift', {
      body: { model: 'lab/small', input: { text: 'hei' }, synthetic: true },
      reason,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'admission' }] });
    expect(server.seen).toEqual([]);
  });

  it('a raw descriptor call takes synthetic data only', async () => {
    const { send, server } = await boot('test');
    for (const synthetic of [false, undefined]) {
      const response = await send(path, 'drift', {
        body: {
          model: 'lab/small',
          input: { text: 'hei' },
          ...(synthetic === false ? { synthetic } : {}),
        },
        reason,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ errors: [{ path: 'synthetic' }] });
    }
    expect(server.seen).toEqual([]);
  });

  it('a raw descriptor call masks every PII category even when the tenant masks none', async () => {
    const { send, server } = await boot('test');
    const text = `Fnr ${syntheticNationalId}, ring +47 912 34 567, skriv til ola@example.no, diagnose F32.1`;
    const response = await send(path, 'drift', {
      body: { model: 'lab/small', input: { text }, synthetic: true },
      reason,
    });
    expect(response.status).toBe(200);
    const sent = JSON.stringify(server.seen[0]?.body);
    for (const value of [syntheticNationalId, '912 34 567', 'ola@example.no', 'F32.1'])
      expect(sent).not.toContain(value);
    expect(sent).toContain('«NATIONAL_ID_1»');
    expect(sent).toContain('«EMAIL_1»');
  });

  it('a raw descriptor call refuses media', async () => {
    const { send, server } = await boot('test');
    const response = await send(path, 'drift', {
      body: {
        model: 'lab/small',
        input: { text: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        synthetic: true,
      },
      reason,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errors: [{ path: 'media' }] });
    expect(server.seen).toEqual([]);
  });

  it('a raw descriptor call is a kernel task, audited and metered like any call', async () => {
    const { send, platform, admin } = await boot('test');
    const response = await send(path, 'drift', {
      body: { model: 'lab/small', input: { text: 'hei' }, synthetic: true },
      reason,
    });
    const task = response.headers.get('genai-task') ?? '';
    expect(task).not.toBe('');
    const events = [];
    for await (const e of await platform.kernel.events(
      { kind: 'operator', issuer: 'platform', subject: 'audit-reader' },
      task,
      { audience: 'audit' },
    ))
      events.push(e);
    expect(events.find((e) => e.type === 'kernel.gate.call')?.data).toEqual({
      port: 'operation',
      operation: 'classify',
      model: 'lab/small',
      endpoint: 'lab',
      descriptor: 'example/classify@1',
      residency: 'norway',
      outcome: 'ok',
      usage: { inputTokens: 7, requests: 1 },
      dropped: 1,
    });
    expect(events.find((e) => e.type === 'kernel.usage')?.data).toMatchObject({
      usage: { inputTokens: 7, requests: 1 },
    });
    expect((await admin.audit()).find((a) => a.action === 'platform.operations.try')).toMatchObject(
      {
        actor: 'operator:test:drift',
        outcome: 'applied',
        target: 'operation:example/classify@1',
        reason,
      },
    );
  });
});
