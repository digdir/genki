import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Principal } from '@genai/contracts';
import { syntheticNationalId } from '@genai/kernel/gate-contract';
import { descriptorRegistry, loadDescriptors, parseDescriptor } from '@genai/operations';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { bootPlatform, digdir } from './testkit.js';

const classifyYaml = (status: 'review' | 'described') => `
id: example/classify@1
operation: classify
status: ${status}
summary: A made-up classification API, used by a service.
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
`;

const registry = (status: 'review' | 'described' = 'described') =>
  descriptorRegistry([...loadDescriptors().list(), parseDescriptor(classifyYaml(status))]);

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  vakt: { kind: 'operator', issuer: 'test', subject: 'vakt' },
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
};

const caller: Principal = {
  kind: 'agency-system',
  issuer: 'test',
  subject: 'saksbehandling',
  tenant: digdir,
  scopes: ['legacy:query'],
};

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const reason = 'Styrer en ny type modellkall';

const boot = async (
  options: { environmentTier?: 'test' | 'production'; status?: 'review' | 'described' } = {},
) => {
  const server = await fakeHttp(() => ({
    status: 200,
    json: { label: 'billing', usage: { input_tokens: 7 } },
  }));
  servers.push(server);
  const booted = await bootPlatform({
    people,
    descriptors: registry(options.status),
    ...(options.environmentTier ? { environmentTier: options.environmentTier } : {}),
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
          capabilities: ['json-schema'],
        },
      ],
    },
  });
  const { send } = booted;
  const setMaturity = (who: string, maturity: 'test' | 'production') =>
    send('/operator/operation-kinds/classify/maturity', who, { body: { maturity }, reason });
  const promote = async () => {
    expect((await setMaturity('drift', 'production')).status).toBe(200);
  };
  const processorRecord = (extra: Record<string, unknown> = {}) =>
    send('/operator/model-endpoints/lab/processor-record', 'drift', {
      method: 'PUT',
      reason,
      body: {
        agreement: 'DPA-2026-17, signed 2026-09-01',
        subProcessors: [{ name: 'Lab Cloud AS', location: 'Norway' }],
        retention: { days: 0, note: 'No abuse monitoring' },
        ...extra,
      },
    });
  return { ...booted, server, setMaturity, promote, processorRecord };
};

const flow = (input: Record<string, unknown> = { text: '{{input.query}}' }) => ({
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant: digdir, id: 'sortering', name: 'Sortering' },
  spec: {
    purpose: 'Sorter en henvendelse',
    input: { query: 'tekst' },
    steps: [
      {
        id: 'sorter',
        name: 'Sorter henvendelsen',
        block: 'call-operation@1',
        params: { descriptor: 'example/classify@1' },
        input,
      },
    ],
  },
});

const service = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'sortering', name: 'Sortering' },
  spec: {
    purpose: 'Sorter henvendelser til riktig kø',
    audience: ['employees'],
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'step-flow', version: 1, config: { flow: 'sortering@1' } },
    model: { primary: 'lab/small', residency: 'norway' },
    guardrails: { 'pii-before-model': { categories: ['national-id'], restore: false } },
    exposure: { rest: true },
  },
};

type Booted = Awaited<ReturnType<typeof boot>>;

const publish = async ({ platform }: Booted, steps: Record<string, unknown> = flow()) => {
  const published = await platform.definitions.publish(steps, 'test', 'test');
  expect(published.ok ? [] : published.errors).toEqual([]);
  return platform.definitions.publish(service, 'test', 'test');
};

const messages = (result: Awaited<ReturnType<typeof publish>>) =>
  result.ok ? [] : result.errors.map((e) => e.message).join('\n');

const auditOf = async ({ platform }: Booted, task: string) => {
  const events: Event[] = [];
  for await (const e of await platform.kernel.events(
    { kind: 'operator', issuer: 'platform', subject: 'audit-reader' },
    task,
    { audience: 'audit' },
  ))
    events.push(e);
  return events;
};

const run = async (booted: Booted, query = 'Jeg vil endre fakturaen') => {
  const started = await booted.platform.kernel.invoke(caller, `${digdir}/sortering/default`, {
    data: { query },
  });
  const outcome = await started.result.then(
    (parts) => ({ ok: true as const, parts }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { task: started.task, ...outcome };
};

describe('the described tier', () => {
  it('a service can publish a call-operation step on a production kind', async () => {
    const booted = await boot();
    await booted.promote();
    expect((await booted.processorRecord()).status).toBe(200);
    expect(messages(await publish(booted))).toEqual([]);
    const ran = await run(booted);
    expect(ran.ok).toBe(true);
    expect(booted.server.seen).toHaveLength(1);
  });

  it('a service cannot publish a call-operation step on a test kind', async () => {
    const booted = await boot();
    expect((await booted.processorRecord()).status).toBe(200);
    expect(messages(await publish(booted))).toContain(
      'the classify operation is in test in this environment',
    );
  });

  it('a service cannot publish a call-operation step on a descriptor in review', async () => {
    const booted = await boot({ status: 'review' });
    await booted.promote();
    expect((await booted.processorRecord()).status).toBe(200);
    expect(messages(await publish(booted))).toContain('example/classify@1 is in review');
  });

  it('a call-operation step on a kind demoted after publish is refused at call', async () => {
    const booted = await boot();
    await booted.promote();
    await booted.processorRecord();
    expect(messages(await publish(booted))).toEqual([]);
    const demoted = await booted.setMaturity('drift', 'test');
    expect(await demoted.json()).toMatchObject({ maturity: 'test', step: 'demoted' });
    const ran = await run(booted);
    expect(ran.ok).toBe(false);
    expect(booted.server.seen).toEqual([]);
    expect(
      (await auditOf(booted, ran.task)).find((e) => e.type === 'kernel.gate.call')?.data,
    ).toMatchObject({
      port: 'described',
      outcome: 'refused',
      refusal: 'maturity',
    });
  });

  it('a call-operation step is masked, metered and audited like any call', async () => {
    const booted = await boot();
    await booted.promote();
    await booted.processorRecord();
    expect(messages(await publish(booted))).toEqual([]);
    const ran = await run(booted, `Fnr ${syntheticNationalId} vil endre fakturaen`);
    expect(ran.ok).toBe(true);
    const sent = JSON.stringify(booted.server.seen[0]?.body);
    expect(sent).not.toContain(syntheticNationalId);
    expect(sent).toContain('«NATIONAL_ID_1»');
    const events = await auditOf(booted, ran.task);
    expect(events.find((e) => e.type === 'kernel.gate.call')?.data).toEqual({
      port: 'described',
      operation: 'classify',
      model: 'lab/small',
      endpoint: 'lab',
      descriptor: 'example/classify@1',
      residency: 'norway',
      outcome: 'ok',
      usage: { inputTokens: 7, requests: 1 },
    });
    expect(events.find((e) => e.type === 'kernel.usage')?.data).toMatchObject({
      usage: { inputTokens: 7, requests: 1 },
    });
  });
});

describe('maturity per operation kind', () => {
  it('one operator promotes a kind to production, audited with who and why', async () => {
    const { setMaturity, send, admin } = await boot();
    const promoted = await setMaturity('drift', 'production');
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({
      kind: 'classify',
      environment: 'production',
      maturity: 'production',
      step: 'promoted',
      by: 'operator:test:drift',
    });
    const listed = (await (await send('/operator/operation-kinds', 'drift')).json()) as {
      data: { kind: string; maturity: string; descriptors: { id: string }[] }[];
    };
    expect(listed.data.find((k) => k.kind === 'classify')).toMatchObject({
      maturity: 'production',
      descriptors: [{ id: 'example/classify@1', status: 'described' }],
    });
    const audited = (await admin.audit()).filter(
      (a) => a.action === 'platform.operations.maturity',
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      actor: 'operator:test:drift',
      target: 'operation-kind:classify',
      outcome: 'applied',
      reason,
      at: expect.any(String),
    });
  });

  it('one operator moves a kind back to test', async () => {
    const { setMaturity, promote } = await boot();
    await promote();
    expect(await (await setMaturity('vakt', 'test')).json()).toMatchObject({
      maturity: 'test',
      step: 'demoted',
      by: 'operator:test:vakt',
    });
  });

  it('promoting a kind already in production changes nothing', async () => {
    const { setMaturity, promote, admin } = await boot();
    await promote();
    expect(await (await setMaturity('vakt', 'production')).json()).toMatchObject({
      maturity: 'production',
      step: 'unchanged',
      by: 'operator:test:drift',
    });
    expect(
      (await admin.audit()).filter((a) => a.action === 'platform.operations.maturity'),
    ).toHaveLength(1);
  });

  it('a maturity change without a change reason is refused', async () => {
    const { send } = await boot();
    const refused = await send('/operator/operation-kinds/classify/maturity', 'drift', {
      body: { maturity: 'production' },
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ errors: [{ path: 'change-reason' }] });
  });

  it('only operators set the maturity of a kind', async () => {
    const { setMaturity } = await boot();
    expect((await setMaturity('kari', 'production')).status).toBe(403);
  });
});

describe('processor records', () => {
  it('an endpoint without a processor record cannot serve a service with real data', async () => {
    const booted = await boot();
    await booted.promote();
    expect(messages(await publish(booted))).toContain('lab of lab/small has no processor record');
    expect((await booted.processorRecord()).status).toBe(200);
    expect(messages(await booted.platform.definitions.publish(service, 'test', 'test'))).toEqual(
      [],
    );
    const removed = await booted.send('/operator/model-endpoints/lab/processor-record', 'drift', {
      method: 'DELETE',
      reason,
    });
    expect(removed.status).toBe(204);
    const ran = await run(booted);
    expect(ran.ok).toBe(false);
    expect(booted.server.seen).toEqual([]);
    expect(
      (await auditOf(booted, ran.task)).find((e) => e.type === 'kernel.gate.call')?.data,
    ).toMatchObject({ outcome: 'refused', refusal: 'processor' });
  });

  it('a synthetic operator call needs no processor record', async () => {
    const { send, server } = await boot({ environmentTier: 'test' });
    const tried = await send('/operator/operations/example/classify@1/try', 'drift', {
      body: { model: 'lab/small', input: { text: 'hei' }, synthetic: true },
      reason,
    });
    expect(tried.status).toBe(200);
    expect(server.seen).toHaveLength(1);
  });

  it('media to a described operation needs acceptsUnmaskedInput on the endpoint', async () => {
    const booted = await boot();
    await booted.promote();
    await booted.processorRecord();
    const image = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }];
    expect(messages(await publish(booted, flow({ text: image })))).toEqual([]);
    const refused = await run(booted);
    expect(refused.ok).toBe(false);
    expect(booted.server.seen).toEqual([]);
    expect(
      (await auditOf(booted, refused.task)).find((e) => e.type === 'kernel.gate.call')?.data,
    ).toMatchObject({ outcome: 'refused', refusal: 'media' });
    expect(
      (
        await booted.processorRecord({
          acceptsUnmaskedInput: true,
          unmaskedInputReason: 'Skjermbilder av fakturaer; avtalen dekker bilder',
        })
      ).status,
    ).toBe(200);
    expect((await run(booted)).ok).toBe(true);
    expect(JSON.stringify(booted.server.seen[0]?.body)).toContain('data:image/png;base64,AAAA');
  });

  it('accepting unmasked input needs a reason', async () => {
    const { processorRecord } = await boot();
    const refused = await processorRecord({ acceptsUnmaskedInput: true });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ errors: [{ path: 'unmaskedInputReason' }] });
  });

  it('operators record a processor record per endpoint, audited', async () => {
    const { processorRecord, send, admin } = await boot();
    expect((await send('/operator/processor-records', 'drift')).status).toBe(200);
    const before = (await (await send('/operator/processor-records', 'drift')).json()) as {
      data: { endpoint: string; record: unknown }[];
    };
    expect(before.data).toContainEqual({ endpoint: 'lab', record: null });
    expect((await processorRecord()).status).toBe(200);
    const read = await send('/operator/model-endpoints/lab/processor-record', 'drift');
    expect(await read.json()).toMatchObject({
      endpoint: 'lab',
      by: 'operator:test:drift',
      record: {
        agreement: 'DPA-2026-17, signed 2026-09-01',
        subProcessors: [{ name: 'Lab Cloud AS', location: 'Norway' }],
        retention: { days: 0 },
        acceptsUnmaskedInput: false,
      },
    });
    expect(
      (await admin.audit()).find((a) => a.action === 'platform.operations.processor-record'),
    ).toMatchObject({
      actor: 'operator:test:drift',
      outcome: 'applied',
      target: 'model-endpoint:lab/processor-record',
      reason,
    });
    expect((await send('/operator/processor-records', 'kari')).status).toBe(403);
  });
});
