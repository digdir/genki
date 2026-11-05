import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { bootPlatform, digdir } from './testkit.js';

const classifyYaml = (
  overrides: { input?: string; wireText?: string; extra?: string; status?: string } = {},
) => `
id: example/classify@1
operation: classify
status: ${overrides.status ?? 'review'}
summary: A made-up classification API, uploaded by an operator.
api:
  family: openai
  version: 2026-10-01${overrides.extra ?? ''}
request:
  method: POST
  path: /classifications
  body:
    model: $deployment
    text: $input.text
input:
  object:
    text: ${overrides.input ?? 'text'}
output:
  object:
    label: plain
wire:
  request:
    object:
      model: plain
      text: ${overrides.wireText ?? 'text'}
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

const fixture = (label = 'billing') => ({
  name: 'billing',
  source: 'hand-made for the upload test; not a recording',
  deployment: 'small',
  input: { text: 'Jeg vil endre fakturaen' },
  request: {
    method: 'POST',
    path: '/classifications',
    body: { model: 'small', text: 'Jeg vil endre fakturaen' },
  },
  response: {
    status: 200,
    body: { label: 'billing', usage: { input_tokens: 7 }, id: 'cls_1' },
  },
  result: { label },
  usage: { inputTokens: 7, requests: 1 },
  dropped: 1,
});

const upload = (descriptor: unknown = classifyYaml(), fixtures: unknown[] = [fixture()]) => ({
  descriptor,
  fixtures,
});

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

const reason = 'Laster opp et nytt API etter gjennomgang';
const path = '/operator/operation-descriptors/example/classify@1';

const boot = async (environmentTier?: 'test' | 'production') => {
  const server = await fakeHttp(() => ({
    status: 200,
    json: { label: 'billing', usage: { input_tokens: 7 } },
  }));
  servers.push(server);
  const booted = await bootPlatform({
    people,
    ...(environmentTier ? { environmentTier } : {}),
    models: {
      endpoints: {
        lab: {
          families: { openai: '' },
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
  const put = (body: unknown = upload(), as = 'drift') =>
    send(path, as, { method: 'PUT', body, reason });
  const setStatus = (status: string) =>
    send(`${path}/status`, 'drift', { body: { status }, reason });
  const withdraw = () => send(path, 'drift', { method: 'DELETE', reason });
  const offerClassify = () =>
    booted.admin.classifyModel(
      people.drift as Principal,
      'lab/small',
      { apis: { chat: 'openai/chat-completions@1', classify: 'example/classify@1' } },
      reason,
    );
  const tryIt = () =>
    send(`/operator/operations/example/classify@1/try`, 'drift', {
      body: { model: 'lab/small', input: { text: 'hei' }, synthetic: true },
      reason,
    });
  return { ...booted, server, put, setStatus, withdraw, offerClassify, tryIt };
};

type Booted = Awaited<ReturnType<typeof boot>>;

const errorsOf = async (response: Response) =>
  ((await response.json()) as { errors: { path: string; message: string }[] }).errors;

const flow = {
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
        input: { text: '{{input.query}}' },
      },
    ],
  },
};

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

const publishService = async ({ platform, send }: Booted) => {
  expect(
    (
      await send('/operator/operation-kinds/classify/maturity', 'drift', {
        body: { maturity: 'production' },
        reason,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await send('/operator/model-endpoints/lab/processor-record', 'drift', {
        method: 'PUT',
        reason,
        body: {
          agreement: 'DPA-2026-17',
          subProcessors: [{ name: 'Lab Cloud AS', location: 'Norway' }],
          retention: { days: 0 },
        },
      })
    ).status,
  ).toBe(200);
  const steps = await platform.definitions.publish(flow, 'test', 'test');
  expect(steps.ok ? [] : steps.errors).toEqual([]);
  return platform.definitions.publish(service, 'test', 'test');
};

const run = async ({ platform }: Booted) => {
  const started = await platform.kernel.invoke(caller, `${digdir}/sortering/default`, {
    data: { query: 'Jeg vil endre fakturaen' },
  });
  return started.result.then(
    () => true,
    (error: unknown) => String(error),
  );
};

describe('uploading operation descriptors', () => {
  it('an operator uploads a descriptor and tries it in the raw tier without a restart', async () => {
    const booted = await boot('test');
    expect((await booted.tryIt()).status).toBe(404);
    const uploaded = await booted.put();
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({
      id: 'example/classify@1',
      operation: 'classify',
      status: 'review',
      source: 'uploaded',
      fixtures: 1,
      contract: { suite: 'operation@1', passed: true },
      by: 'operator:test:drift',
      reason,
      step: 'uploaded',
    });
    expect((await booted.offerClassify()).ok).toBe(true);
    const tried = await booted.tryIt();
    expect(tried.status).toBe(200);
    expect(await tried.json()).toMatchObject({ result: { label: 'billing' } });
    expect(booted.server.seen).toHaveLength(1);
  });

  it('an uploaded API can be bound to a model for its kind', async () => {
    const booted = await boot();
    expect(await booted.offerClassify()).toMatchObject({
      ok: false,
      errors: [{ path: 'apis', message: 'classify: no API example/classify@1' }],
    });
    expect((await booted.put()).status).toBe(201);
    expect(await booted.offerClassify()).toMatchObject({
      ok: true,
      value: { operations: ['chat', 'classify'] },
    });
  });

  it('a descriptor may be uploaded as JSON as well as YAML text', async () => {
    const { put } = await boot();
    const { parse } = await import('yaml');
    expect((await put(upload(parse(classifyYaml())))).status).toBe(201);
  });

  it('an upload that breaks a loader rule is refused with the reason', async () => {
    const { put, send } = await boot();
    const refused = await put(
      upload(classifyYaml({ extra: '\n  headers:\n    authorization: Bearer abc' })),
    );
    expect(refused.status).toBe(422);
    expect(await errorsOf(refused)).toContainEqual({
      path: 'descriptor',
      message: 'example/classify@1: api.headers.authorization: credentials come from the endpoint',
    });
    expect((await send(path, 'drift')).status).toBe(404);
  });

  it('an upload whose fixtures fail operation@1 is refused', async () => {
    const { put } = await boot();
    const refused = await put(upload(classifyYaml(), [fixture('complaint')]));
    expect(refused.status).toBe(422);
    const errors = await errorsOf(refused);
    expect(errors[0]?.path).toBe('fixtures.billing');
    expect(errors.map((e) => e.message).join('\n')).toContain(
      'the recorded response maps to the typed result',
    );
  });

  it('an upload whose input reaches the wire unmasked is refused', async () => {
    const { put } = await boot();
    const refused = await put(upload(classifyYaml({ input: 'plain', wireText: 'plain' })));
    expect(refused.status).toBe(422);
    expect((await errorsOf(refused)).map((e) => e.message).join('\n')).toContain(
      'reached the wire unmasked',
    );
  });

  it('an upload may come without fixtures and stays in review until operation@1 passes on one', async () => {
    const { put, setStatus } = await boot();
    const none = await put(upload(classifyYaml(), []));
    expect(none.status).toBe(201);
    expect(await none.json()).toMatchObject({ status: 'review', fixtures: 0, contract: null });
    const described = await setStatus('described');
    expect(described.status).toBe(422);
    expect((await errorsOf(described))[0]?.path).toBe('fixtures');
  });

  it('an upload needs well-formed fixtures', async () => {
    const { put } = await boot();
    const malformed = await put(upload(classifyYaml(), [{ ...fixture(), usage: undefined }]));
    expect(malformed.status).toBe(422);
    expect((await errorsOf(malformed))[0]?.path).toBe('fixtures.0.usage');
  });

  it('an upload larger than the limit is refused', async () => {
    const { put } = await boot();
    const huge = await put(upload(classifyYaml(), [{ ...fixture(), source: 'x'.repeat(600_000) }]));
    expect(huge.status).toBe(413);
  });

  it('an upload is never typed and starts in review', async () => {
    const { put, setStatus } = await boot();
    const typed = await put(upload(classifyYaml({ status: 'typed' })));
    expect(typed.status).toBe(422);
    expect((await errorsOf(typed))[0]?.path).toBe('descriptor.status');
    const described = await put(upload(classifyYaml({ status: 'described' })));
    expect(described.status).toBe(422);
    expect((await put()).status).toBe(201);
    expect((await setStatus('typed')).status).toBe(400);
  });

  it('an upload under another id than its own is refused', async () => {
    const { send } = await boot();
    const refused = await send('/operator/operation-descriptors/example/classify@2', 'drift', {
      method: 'PUT',
      body: upload(),
      reason,
    });
    expect(refused.status).toBe(422);
    expect((await errorsOf(refused))[0]?.path).toBe('id');
  });

  it('an uploaded descriptor cannot replace a bundled one', async () => {
    const { send } = await boot();
    const refused = await send('/operator/operation-descriptors/openai/embeddings@1', 'drift', {
      method: 'PUT',
      body: upload(),
      reason,
    });
    expect(refused.status).toBe(409);
    expect((await errorsOf(refused))[0]?.message).toContain('upload a new version instead');
    const withdrawn = await send('/operator/operation-descriptors/openai/embeddings@1', 'drift', {
      method: 'DELETE',
      reason,
    });
    expect(withdrawn.status).toBe(409);
  });

  it('a described descriptor is not replaced; a new version is uploaded instead', async () => {
    const { put, setStatus } = await boot();
    expect((await put()).status).toBe(201);
    expect((await put()).status).toBe(200);
    expect((await setStatus('described')).status).toBe(200);
    expect((await put()).status).toBe(409);
  });

  it('only operators upload descriptors', async () => {
    const { put, send } = await boot();
    expect((await put(upload(), 'kari')).status).toBe(403);
    expect((await send('/operator/operation-descriptors', 'kari')).status).toBe(403);
    expect((await send(path, 'kari', { method: 'DELETE', reason })).status).toBe(403);
    expect((await send(path, 'drift')).status).toBe(404);
  });

  it('a write without a change reason is refused', async () => {
    const { send } = await boot();
    expect((await send(path, 'drift', { method: 'PUT', body: upload() })).status).toBe(400);
  });

  it('the list shows bundled and uploaded descriptors with source, status, fixtures and operation@1', async () => {
    const { put, send } = await boot();
    expect((await put()).status).toBe(201);
    const listed = (await (await send('/operator/operation-descriptors', 'drift')).json()) as {
      data: { id: string }[];
    };
    expect(listed.data.find((d) => d.id === 'openai/embeddings@1')).toMatchObject({
      source: 'bundled',
      status: 'typed',
      fixtures: 2,
      contract: { suite: 'operation@1', passed: true },
    });
    expect(listed.data.find((d) => d.id === 'example/classify@1')).toMatchObject({
      source: 'uploaded',
      status: 'review',
      fixtures: 1,
      contract: { passed: true },
    });
    const one = await send(path, 'drift');
    expect(await one.json()).toMatchObject({
      document: { id: 'example/classify@1' },
      fixtureCases: [{ name: 'billing' }],
    });
  });

  it('an upload, a status change and a withdrawal are audited with who, when and why', async () => {
    const { put, setStatus, withdraw, admin, configEntries } = await boot();
    expect((await put()).status).toBe(201);
    const described = await setStatus('described');
    expect(await described.json()).toMatchObject({ status: 'described', step: 'described' });
    expect(await (await setStatus('described')).json()).toMatchObject({ step: 'unchanged' });
    expect((await withdraw()).status).toBe(204);
    const audited = (await admin.audit()).filter((a) =>
      a.action.startsWith('platform.operations.descriptor-'),
    );
    expect(audited.map((a) => a.action).sort()).toEqual([
      'platform.operations.descriptor-status',
      'platform.operations.descriptor-upload',
      'platform.operations.descriptor-withdraw',
    ]);
    for (const a of audited)
      expect(a).toMatchObject({
        actor: 'operator:test:drift',
        target: 'operation-descriptor:example/classify@1',
        outcome: 'applied',
        reason,
        at: expect.any(String),
      });
    const history = await configEntries.history(
      'operation-descriptor',
      'platform',
      'example/classify@1',
    );
    expect(history.map((e) => [e.deleted, (e.spec as { status: string }).status])).toEqual([
      [false, 'review'],
      [false, 'described'],
      [true, 'described'],
    ]);
    for (const e of history) expect(e).toMatchObject({ by: 'operator:test:drift', reason });
  });

  it('an uploaded descriptor serves a service only once described', async () => {
    const booted = await boot();
    expect((await booted.put()).status).toBe(201);
    expect((await booted.offerClassify()).ok).toBe(true);
    const inReview = await publishService(booted);
    expect(inReview.ok ? [] : inReview.errors.map((e) => e.message).join('\n')).toContain(
      'example/classify@1 is in review',
    );
    expect((await booted.setStatus('described')).status).toBe(200);
    const published = await booted.platform.definitions.publish(service, 'test', 'test');
    expect(published.ok ? [] : published.errors).toEqual([]);
    expect(await run(booted)).toBe(true);
  });

  it('a withdrawn descriptor is refused at call', async () => {
    const booted = await boot();
    expect((await booted.put()).status).toBe(201);
    expect((await booted.setStatus('described')).status).toBe(200);
    expect((await booted.offerClassify()).ok).toBe(true);
    const published = await publishService(booted);
    expect(published.ok ? [] : published.errors).toEqual([]);
    expect(await run(booted)).toBe(true);
    expect(booted.server.seen).toHaveLength(1);
    expect((await booted.withdraw()).status).toBe(204);
    expect(await run(booted)).toContain('no descriptor example/classify@1');
    expect(booted.server.seen).toHaveLength(1);
  });
});

describe('recording fixtures from tries', () => {
  const fixtures = `${path}/fixtures`;
  type Tried = { task: string; exchange: Record<string, unknown> };
  const tryWith = async (booted: Booted, text: string) => {
    const tried = await booted.send('/operator/operations/example/classify@1/try', 'drift', {
      body: { model: 'lab/small', input: { text }, synthetic: true },
      reason,
    });
    expect(tried.status).toBe(200);
    return (await tried.json()) as Tried;
  };
  const record = (booted: Booted, body: unknown, id = path) =>
    booted.send(`${id}/fixtures`, 'drift', { body, reason });
  const ready = async () => {
    const booted = await boot('test');
    expect((await booted.put(upload(classifyYaml(), []))).status).toBe(201);
    expect((await booted.offerClassify()).ok).toBe(true);
    return booted;
  };

  it('a try answers the exchange it sent and received, with the input masked', async () => {
    const booted = await ready();
    const tried = await tryWith(booted, 'Skriv til kari.nordmann@example.no');
    expect(tried.exchange).toMatchObject({
      deployment: 'small',
      request: { method: 'POST', path: '/classifications', body: { model: 'small' } },
      response: { status: 200, body: { label: 'billing' } },
      result: { label: 'billing' },
      usage: { inputTokens: 7, requests: 1 },
      dropped: 0,
    });
    expect(JSON.stringify(tried.exchange)).not.toContain('kari.nordmann@example.no');
  });

  it('a synthetic try is recorded as a fixture of its upload in review, audited', async () => {
    const booted = await ready();
    const tried = await tryWith(booted, 'Skriv til kari.nordmann@example.no');
    const recorded = await record(booted, {
      task: tried.task,
      name: 'first-try',
      exchange: tried.exchange,
    });
    expect(recorded.status).toBe(201);
    expect(await recorded.json()).toMatchObject({
      status: 'review',
      fixtures: 1,
      contract: { passed: true },
      step: 'fixture-recorded',
    });
    const stored = (await (await booted.send(path, 'drift')).json()) as {
      fixtureCases: { name: string; source: string; input: { text: string } }[];
    };
    expect(stored.fixtureCases[0]).toMatchObject({
      name: 'first-try',
      source: `recorded from the synthetic try ${tried.task}`,
    });
    expect(stored.fixtureCases[0]?.input.text).not.toContain('kari.nordmann@example.no');
    expect((await booted.setStatus('described')).status).toBe(200);
    const audited = (await booted.admin.audit()).find(
      (a) => a.action === 'platform.operations.descriptor-fixture',
    );
    expect(audited).toMatchObject({
      actor: 'operator:test:drift',
      target: 'operation-descriptor:example/classify@1',
      outcome: 'applied',
      reason,
    });
  });

  it('a fixture is recorded only with the exchange the try answered', async () => {
    const booted = await ready();
    const tried = await tryWith(booted, 'hei');
    const changed = { ...tried.exchange, result: { label: 'complaint' } };
    const refused = await record(booted, { task: tried.task, name: 'edited', exchange: changed });
    expect(refused.status).toBe(422);
    expect((await errorsOf(refused))[0]?.path).toBe('exchange');
    const notATry = await record(booted, {
      task: 'no-such-task',
      name: 'edited',
      exchange: tried.exchange,
    });
    expect(notATry.status).toBe(422);
    expect((await errorsOf(notATry))[0]?.path).toBe('task');
  });

  it('a fixture name is used once per descriptor', async () => {
    const booted = await ready();
    const tried = await tryWith(booted, 'hei');
    const body = { task: tried.task, name: 'same', exchange: tried.exchange };
    expect((await record(booted, body)).status).toBe(201);
    const again = await record(booted, body);
    expect(again.status).toBe(422);
    expect((await errorsOf(again))[0]?.path).toBe('name');
  });

  it('fixtures are recorded only in test', async () => {
    const booted = await boot('production');
    expect((await booted.put()).status).toBe(201);
    const refused = await booted.send(fixtures, 'drift', {
      body: { task: 't', name: 'x', exchange: {} },
      reason,
    });
    expect(refused.status).toBe(403);
    expect((await errorsOf(refused))[0]?.path).toBe('environment');
  });

  it('a bundled descriptor or a described upload takes no recorded fixture', async () => {
    const booted = await ready();
    const tried = await tryWith(booted, 'hei');
    const body = { task: tried.task, name: 'late', exchange: tried.exchange };
    expect(
      (await record(booted, body, '/operator/operation-descriptors/openai/embeddings@1')).status,
    ).toBe(409);
    expect((await record(booted, { ...body, name: 'first' })).status).toBe(201);
    expect((await booted.setStatus('described')).status).toBe(200);
    expect((await record(booted, body)).status).toBe(409);
  });
});

describe('who uses a descriptor', () => {
  it("a descriptor's detail names the published services whose steps call it", async () => {
    const booted = await boot();
    expect((await booted.put()).status).toBe(201);
    expect(await (await booted.send(path, 'drift')).json()).toMatchObject({ usedBy: [] });
    expect((await booted.setStatus('described')).status).toBe(200);
    expect((await booted.offerClassify()).ok).toBe(true);
    const published = await publishService(booted);
    expect(published.ok ? [] : published.errors).toEqual([]);
    const detail = (await (await booted.send(path, 'drift')).json()) as {
      usedBy: unknown[];
      input: unknown;
    };
    expect(detail.usedBy).toEqual([{ tenant: digdir, service: 'sortering', version: 1 }]);
    expect(detail.input).toEqual({ kind: 'object', fields: { text: { kind: 'text' } } });
  });

  it('the operation kinds name the API family each descriptor speaks', async () => {
    const booted = await boot();
    expect((await booted.put()).status).toBe(201);
    const kinds = (await (await booted.send('/operator/operation-kinds', 'drift')).json()) as {
      data: { kind: string; descriptors: unknown[] }[];
    };
    expect(kinds.data.find((k) => k.kind === 'classify')?.descriptors).toEqual([
      { id: 'example/classify@1', status: 'review', family: 'openai' },
    ]);
  });
});
