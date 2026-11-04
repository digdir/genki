import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Principal } from '@genai/contracts';
import { mediaRefKind, type MediaOutputConfig } from '@genai/kernel';
import { descriptorRegistry, loadDescriptors, parseDescriptor } from '@genai/operations';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { bootPlatform, digdir } from './testkit.js';
import { toTimeline } from './timeline.js';

const imageYaml = `
id: example/generate-image@1
operation: generate-image
status: described
summary: A made-up image generation API.
api:
  protocol: openai-chat
  version: 2026-10-01
request:
  method: POST
  path: /images/generations
  body:
    model: $deployment
    prompt: $input.prompt
input:
  object:
    prompt: text
output:
  object:
    created: number
    images:
      array:
        object:
          b64: { media: image/png }
          revisedPrompt?: text
wire:
  request:
    object:
      model: plain
      prompt: text
  response:
    object:
      created: number
      data:
        array:
          object:
            b64_json: plain
            revised_prompt?: text
result:
  created: $response.created
  images: { $each: $response.data, $map: { b64: $item.b64_json, revisedPrompt: $item.revised_prompt } }
usage:
  requests: 1
stream: none
`;

const speechYaml = `
id: example/speak@1
operation: speak
status: described
summary: A made-up text to speech API.
api:
  protocol: openai-chat
  version: 2026-10-01
request:
  method: POST
  path: /audio/speech
  body:
    model: $deployment
    input: $input.text
input:
  object:
    text: text
output:
  object:
    audio: { media: audio/wav }
wire:
  request:
    object:
      model: plain
      input: text
  response:
    object:
      audio: plain
result:
  audio: $response.audio
usage:
  requests: 1
stream: none
`;

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const png = pngBytes.toString('base64');
const wavBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(120, 7)]);
const wav = wavBytes.toString('base64');

const caller: Principal = {
  kind: 'agency-system',
  issuer: 'test',
  subject: 'saksbehandling',
  tenant: digdir,
  scopes: ['legacy:query'],
};

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  saksbehandling: caller,
  annen: { ...caller, subject: 'annen' },
};

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const reason = 'Tjenesten lager figurer';

const boot = async (mediaOutput?: MediaOutputConfig) => {
  const server = await fakeHttp((_body, _attempt, path) =>
    path.endsWith('/audio/speech')
      ? { status: 200, json: { audio: wav } }
      : {
          status: 200,
          json: { created: 1, data: [{ b64_json: png, revised_prompt: 'En figur' }] },
        },
  );
  servers.push(server);
  const booted = await bootPlatform({
    people,
    descriptors: descriptorRegistry([
      ...loadDescriptors().list(),
      parseDescriptor(imageYaml),
      parseDescriptor(speechYaml),
    ]),
    ...(mediaOutput ? { mediaOutput } : {}),
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
          operations: ['chat', 'generate-image', 'speak'],
        },
      ],
    },
  });
  for (const kind of ['generate-image', 'speak'])
    expect(
      (
        await booted.send(`/operator/operation-kinds/${kind}/maturity`, 'drift', {
          body: { maturity: 'production' },
          reason,
        })
      ).status,
    ).toBe(200);
  expect(
    (
      await booted.send('/operator/model-endpoints/lab/processor-record', 'drift', {
        method: 'PUT',
        reason,
        body: {
          agreement: 'DPA-2026-17, signed 2026-09-01',
          subProcessors: [{ name: 'Lab Cloud AS', location: 'Norway' }],
          retention: { days: 0, note: 'No abuse monitoring' },
        },
      })
    ).status,
  ).toBe(200);
  return { ...booted, server };
};

type Booted = Awaited<ReturnType<typeof boot>>;

const flow = (descriptor: string, input: Record<string, unknown>, answer: string) => ({
  apiVersion: 'genai/v1',
  kind: 'StepFlow',
  metadata: { tenant: digdir, id: 'figur', name: 'Figur' },
  spec: {
    purpose: 'Lag en figur til svaret',
    input: { query: 'tekst' },
    steps: [
      {
        id: 'diagram',
        name: 'Lag figuren',
        block: 'call-operation@1',
        params: { descriptor },
        input,
      },
      { id: 'answer', name: 'Svar', block: 'answer@1', input: { text: answer } },
    ],
  },
});

const service = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'figur', name: 'Figur' },
  spec: {
    purpose: 'Lag figurer til saksbehandlere',
    audience: ['employees'],
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'step-flow', version: 1, config: { flow: 'figur@1' } },
    model: { primary: 'lab/small', residency: 'norway' },
    guardrails: { 'pii-before-model': { categories: ['national-id'], restore: false } },
    exposure: { rest: true },
  },
};

const publish = async (
  { platform }: Booted,
  descriptor = 'example/generate-image@1',
  input: Record<string, unknown> = { prompt: '{{input.query}}' },
  answer = 'Her er figuren, {{steps.diagram.output.result.images.0.b64.bytes}} byte {{steps.diagram.output.result.images.0.b64.mediaType}}.',
) => {
  const flowed = await platform.definitions.publish(
    flow(descriptor, input, answer),
    'test',
    'test',
  );
  expect(flowed.ok ? [] : flowed.errors).toEqual([]);
  const published = await platform.definitions.publish(service, 'test', 'test');
  expect(published.ok ? [] : published.errors).toEqual([]);
};

interface Attachment {
  type: string;
  id: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  step?: string;
  url: string;
}

const ask = async ({ send }: Booted, extra: Record<string, unknown> = {}) => {
  const response = await send('/v1/chat/completions', 'saksbehandling', {
    body: {
      model: 'figur__default',
      messages: [{ role: 'user', content: 'Vis saksgangen som en figur' }],
      ...extra,
    },
  });
  return {
    response,
    task: response.headers.get('genai-task') ?? '',
    text: await response.text(),
  };
};

const eventsOf = async ({ platform }: Booted, task: string) => {
  const events: Event[] = [];
  for await (const e of await platform.kernel.events(
    { kind: 'operator', issuer: 'platform', subject: 'audit-reader' },
    task,
    { audience: 'audit' },
  ))
    events.push(e);
  return events;
};

describe('media output from a call-operation step', () => {
  it('an image a step generates is returned on the answer as an attachment, and later steps read its reference', async () => {
    const booted = await boot();
    await publish(booted);
    const { response, text, task } = await ask(booted);
    expect(response.status).toBe(200);
    const body = JSON.parse(text) as {
      choices: { message: { content: string } }[];
      attachments: Attachment[];
    };
    expect(body.choices[0]?.message.content).toBe(
      `Her er figuren, ${pngBytes.byteLength} byte image/png.`,
    );
    expect(body.attachments).toEqual([
      {
        type: 'image',
        id: expect.any(String),
        mediaType: 'image/png',
        bytes: pngBytes.byteLength,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        step: 'diagram',
        url: `/v1/tasks/${task}/media/${body.attachments[0]?.id}`,
      },
    ]);
  });

  it('media output is stored as a blob reference, not inline in the result or the timeline', async () => {
    const booted = await boot();
    await publish(booted);
    const { text, task } = await ask(booted);
    expect(text).not.toContain(png);
    const events = await eventsOf(booted, task);
    expect(JSON.stringify(events)).not.toContain(png);
    const result = (await booted.platform.kernel.task(caller, task)).result ?? [];
    expect(result.find((p) => p.mime === 'image/png')?.body).toEqual({
      kind: 'blob',
      ref: { kind: mediaRefKind, id: expect.stringMatching(/^runs\//), tenant: digdir },
    });
    const step = events.find(
      (e) =>
        e.type === 'kernel.notice' &&
        (e.data as { step?: string; status?: string }).step === 'diagram' &&
        (e.data as { status?: string }).status === 'done',
    );
    expect(step?.data).toMatchObject({
      media: [{ id: expect.any(String), mediaType: 'image/png', bytes: pngBytes.byteLength }],
    });
    const timeline = toTimeline(
      await booted.platform.kernel.task(caller, task),
      events,
      new Date(),
    );
    expect(JSON.stringify(timeline)).not.toContain(png);
    const listed = timeline.steps.flatMap((s) => s.blocks).filter((b) => b.kind === 'list');
    expect(listed.map((b) => b.items?.[0]?.[0])).toEqual(['image/png', 'image/png']);
  });

  it('media output is counted in bytes in the gate audit', async () => {
    const booted = await boot();
    await publish(booted);
    const { task } = await ask(booted);
    expect(
      (await eventsOf(booted, task)).find((e) => e.type === 'kernel.gate.call')?.data,
    ).toMatchObject({
      port: 'described',
      operation: 'generate-image',
      outcome: 'ok',
      mediaBytes: pngBytes.byteLength,
    });
  });

  it('media output over its cap is refused, not truncated', async () => {
    const booted = await boot({ types: [{ type: 'image/*', maxBytes: 16 }], maxBytes: 1024 });
    await publish(booted);
    const { response } = await ask(booted);
    expect(response.status).toBe(500);
    const run = await booted.platform.kernel.invoke(caller, `${digdir}/figur/default`, {
      data: { query: 'Vis saksgangen' },
    });
    await expect(run.result).rejects.toThrow('over the cap of 16 bytes');
    const task = run.task;
    expect(booted.server.seen).toHaveLength(2);
    const events = await eventsOf(booted, task);
    expect(events.find((e) => e.type === 'kernel.gate.call')?.data).toMatchObject({
      outcome: 'refused',
      refusal: 'media',
      mediaBytes: pngBytes.byteLength,
      usage: { requests: 1 },
    });
    expect((await booted.platform.kernel.task(caller, task)).result ?? []).toEqual([]);
  });

  it('a media type the environment does not allow is refused before the call', async () => {
    const booted = await boot({ types: [{ type: 'audio/*' }], maxBytes: 1024 });
    await publish(booted);
    const { response } = await ask(booted);
    expect(response.status).toBe(500);
    expect(booted.server.seen).toEqual([]);
  });

  it('a streamed answer ends with the attachments', async () => {
    const booted = await boot();
    await publish(booted);
    const { text } = await ask(booted, { stream: true });
    expect(text).toContain('"attachments":[{"type":"image"');
    expect(text).not.toContain(png);
  });
});

describe('the media route', () => {
  it('serves the bytes to the caller that made the run', async () => {
    const booted = await boot();
    await publish(booted);
    const { text } = await ask(booted);
    const [attachment] = (JSON.parse(text) as { attachments: Attachment[] }).attachments;
    const fetched = await booted.send(attachment?.url ?? '', 'saksbehandling');
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('image/png');
    expect(fetched.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(pngBytes);
  });

  it('the media route refuses a caller without rights to the run', async () => {
    const booted = await boot();
    await publish(booted);
    const { text, task } = await ask(booted);
    const [attachment] = (JSON.parse(text) as { attachments: Attachment[] }).attachments;
    const other = await booted.send(attachment?.url ?? '', 'annen');
    const nobody = await booted.app.request(attachment?.url ?? '');
    const unknown = await booted.send(`/v1/tasks/${task}/media/none`, 'saksbehandling');
    expect([other.status, nobody.status, unknown.status]).toEqual([404, 401, 404]);
    expect(await other.text()).not.toContain(png);
  });
});

describe('media kinds come from descriptors alone', () => {
  it('a new media type needs only a descriptor', async () => {
    const booted = await boot();
    await publish(booted, 'example/speak@1', { text: '{{input.query}}' }, 'Her er opplesningen.');
    const { response, text } = await ask(booted);
    expect(response.status).toBe(200);
    const [attachment] = (JSON.parse(text) as { attachments: Attachment[] }).attachments;
    expect(attachment).toMatchObject({
      type: 'audio',
      mediaType: 'audio/wav',
      bytes: wavBytes.byteLength,
      step: 'diagram',
    });
    expect(text).not.toContain(wav);
    const fetched = await booted.send(attachment?.url ?? '', 'saksbehandling');
    expect(fetched.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(wavBytes);
  });
});

describe('drafts', () => {
  it('a draft still cannot run a call-operation step that makes media', async () => {
    const booted = await boot();
    await publish(booted);
    const draft = await booted.platform.drafts.run({
      principal: caller,
      tenant: digdir,
      definition: service,
      parts: [{ kind: 'text', text: 'Vis saksgangen' }],
      input: { query: 'Vis saksgangen' },
      origin: 'playground',
    });
    expect(draft.ok).toBe(false);
    expect(JSON.stringify(draft)).toContain('not in a draft');
    expect(booted.server.seen).toEqual([]);
  });
});
