import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { descriptorRegistry, loadDescriptors, parseDescriptor } from '@genai/operations';
import { bootPlatform, digdir } from './testkit.js';

const imageYaml = (id: string, operation: string, status: string) => `
id: ${id}
operation: ${operation}
status: ${status}
summary: A made-up image generation API.
api:
  family: openai
  version: 2026-10-01
request:
  method: POST
  path: /images/generations
  body:
    model: $deployment
    prompt: $input.prompt
    size: $input.size
input:
  object:
    prompt: text
    size?: { enum: [small, large] }
output:
  object:
    images:
      array:
        object:
          b64: { media: image/png }
wire:
  request:
    object:
      model: plain
      prompt: text
      size?: { enum: [small, large] }
  response:
    object:
      data:
        array:
          object:
            b64_json: plain
result:
  images: { $each: $response.data, $map: { b64: $item.b64_json } }
usage:
  requests: 1
stream: none
`;

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: digdir,
  authorizedFor: [{ org: digdir }],
} as Principal;

const reason = 'Tjenesten lager figurer';

const boot = async () => {
  const booted = await bootPlatform({
    people: { drift: { kind: 'operator', issuer: 'test', subject: 'drift' }, kari },
    descriptors: descriptorRegistry([
      ...loadDescriptors().list(),
      parseDescriptor(imageYaml('example/generate-image@1', 'generate-image', 'described')),
      parseDescriptor(imageYaml('example/sketch@1', 'sketch', 'described')),
      parseDescriptor(imageYaml('example/draw@1', 'draw', 'review')),
    ]),
    models: {
      endpoints: {
        lab: {
          families: { openai: '' },
          baseURL: 'https://modell.example.no/v1',
          auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
        },
        other: {
          families: { openai: '' },
          baseURL: 'https://annen.example.no/v1',
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
          operations: ['chat', 'generate-image', 'draw'],
        },
        {
          id: 'other/big',
          endpoint: 'other',
          deployment: 'big',
          residency: 'eu',
          capabilities: ['json-schema'],
          operations: ['chat', 'generate-image'],
        },
        {
          id: 'lab/chat',
          endpoint: 'lab',
          deployment: 'chat',
          residency: 'norway',
          capabilities: ['json-schema'],
        },
      ],
    },
  });
  for (const kind of ['generate-image', 'draw'])
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
  return booted;
};

interface Listed {
  id: string;
  operation: string;
  status: string;
  input: { name: string; type: string; required: boolean; values?: string[] }[];
  media: string[];
  models: { id: string; residency: string; processorRecord: boolean }[];
}

const list = async (booted: Awaited<ReturnType<typeof boot>>, tenant = digdir) =>
  booted.send(`/tenants/${tenant}/step-flows/operations`, 'kari');

describe('the operations a step flow may call', () => {
  it('a service owner sees a described operation whose kind is in production, with its typed input', async () => {
    const booted = await boot();
    const res = await list(booted);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Listed[] };
    const image = body.data.find((d) => d.id === 'example/generate-image@1');
    expect(image).toMatchObject({
      operation: 'generate-image',
      status: 'described',
      media: ['image/png'],
      input: [
        { name: 'prompt', type: 'text', required: true },
        { name: 'size', type: 'choice', required: false, values: ['small', 'large'] },
      ],
    });
  });

  it('an operation in review, a kind still in test and decide are not offered to a step', async () => {
    const booted = await boot();
    const body = (await (await list(booted)).json()) as { data: Listed[] };
    expect(body.data.map((d) => d.id)).toEqual(['example/generate-image@1']);
  });

  it('only models that offer the kind are offered, each saying whether its endpoint has a processor record', async () => {
    const booted = await boot();
    const body = (await (await list(booted)).json()) as { data: Listed[] };
    expect(body.data[0]?.models).toEqual([
      expect.objectContaining({ id: 'lab/small', residency: 'norway', processorRecord: true }),
      expect.objectContaining({ id: 'other/big', residency: 'eu', processorRecord: false }),
    ]);
  });

  it('a caller outside the tenant gets 404 and a missing login 401', async () => {
    const booted = await boot();
    const elsewhere = await list(booted, '974760673');
    const anonymous = await booted.app.request(`/tenants/${digdir}/step-flows/operations`);
    expect([elsewhere.status, anonymous.status]).toEqual([404, 401]);
  });
});
