import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGate, GateError, type GateRecord } from '@genai/kernel';
import {
  contractFailures,
  fixturesFor,
  operationContract,
  type OperationFixture,
} from './contract.js';
import { parseDescriptor } from './descriptor.js';
import { describedCall } from './executor.js';
import { bundledDescriptorDir, descriptorFiles, loadDescriptors } from './registry.js';

const fixtureDir = join(import.meta.dirname, '..', 'fixtures');
const registered = loadDescriptors();

describe('operation@1 for every registered descriptor', () => {
  it('finds every descriptor file in the descriptor folder', () => {
    expect(registered.list().length).toBe(descriptorFiles(bundledDescriptorDir).length);
    expect(registered.list().length).toBeGreaterThan(0);
  });

  for (const descriptor of registered.list())
    it(`${descriptor.id} passes operation@1 against its recorded fixtures`, async () => {
      const results = await operationContract(descriptor, fixturesFor(fixtureDir, descriptor.id));
      expect(contractFailures(results)).toEqual([]);
    });

  it('every fixture folder belongs to a registered descriptor', () => {
    const folders = readdirSync(fixtureDir).flatMap((provider) =>
      readdirSync(join(fixtureDir, provider)).map((name) => `${provider}/${name}`),
    );
    expect(folders.filter((id) => !registered.get(id))).toEqual([]);
  });
});

describe('the operation@1 suite', () => {
  const embed = registered.get('openai/embeddings@1');
  if (!embed) throw new Error('the embed descriptor is missing');
  const fixtures = fixturesFor(fixtureDir, embed.id);

  it('a descriptor without fixtures fails the operation@1 suite', async () => {
    expect(existsSync(join(fixtureDir, 'nobody', 'thing@1'))).toBe(false);
    const results = await operationContract(embed, fixturesFor(fixtureDir, 'nobody/thing@1'));
    expect(contractFailures(results)).toEqual([
      { check: 'has recorded fixtures', problems: ['openai/embeddings@1 has no fixtures'] },
    ]);
  });

  it('a descriptor whose request differs from the recorded one fails', async () => {
    const [step] = embed.steps;
    if (!step) throw new Error('the embed descriptor has no step');
    const changed = {
      ...embed,
      steps: [{ ...step, request: { ...step.request, path: '/embedding' } }],
    };
    const failed = contractFailures(await operationContract(changed, fixtures));
    expect(failed.map((f) => f.check)).toContain(
      'one-text: the request built from the typed input is the recorded wire request',
    );
  });

  it('a descriptor whose result mapping differs from the recorded result fails', async () => {
    const changed = {
      ...embed,
      result: {
        vectors: { $each: '$response.data', $map: '$item.embedding' },
        usage: { inputTokens: 0 },
      },
    };
    const failed = contractFailures(await operationContract(changed, fixtures));
    expect(failed.map((f) => f.check)).toContain(
      'unordered-with-unknown-fields: the recorded response maps to the typed result',
    );
  });

  it('a descriptor that puts a non-text input value into a wire text field fails', async () => {
    const yaml = readFileSync(join(bundledDescriptorDir, 'openai', 'decide@1.yaml'), 'utf8');
    const leaking = parseDescriptor(
      yaml.replaceAll('instructions: plain\n', 'instructions: text\n'),
    );
    const failed = contractFailures(
      await operationContract(leaking, fixturesFor(fixtureDir, leaking.id)),
    );
    expect(failed.map((f) => f.check)).toContain(
      'predicate: only input text reaches a text field on the wire',
    );
  });
});

const imageYaml = `
id: example/generate-image@1
operation: generate-image
status: review
summary: A made-up image API for the operation@1 suite.
api:
  family: openai
  version: v1
request:
  method: POST
  path: /images/generations
  body:
    model: $deployment
    prompt: $input.prompt
    image: $input.image
input:
  object:
    prompt: text
    image?: { enum: [none] }
output:
  object:
    images: { array: { object: { b64: plain } } }
    usage: { object: { requests?: { number: { min: 0 } } } }
wire:
  request:
    object:
      model: plain
      prompt: text
      image?: { enum: [none] }
  response:
    object:
      data: { array: { object: { b64_json: plain } } }
result:
  images: { $each: $response.data, $map: { b64: $item.b64_json } }
  usage: $usage
usage:
  requests: 1
stream: none
`;

const imageFixture: OperationFixture = {
  name: 'one-image',
  deployment: 'img',
  input: { prompt: 'En katt' },
  request: {
    method: 'POST',
    path: '/images/generations',
    body: { model: 'img', prompt: 'En katt' },
  },
  response: { body: { data: [{ b64_json: 'QUJD' }] } },
  result: { images: [{ b64: 'QUJD' }], usage: { requests: 1 } },
  usage: { requests: 1 },
};

const personalDataCheck =
  'one-image: a national id, an email and a phone number in any input string reach the wire masked';

const failedChecks = async (yaml: string) =>
  contractFailures(await operationContract(parseDescriptor(yaml), [imageFixture])).map(
    (f) => f.check,
  );

const imageField = (kind: string) =>
  imageYaml.replaceAll('image?: { enum: [none] }', `image?: ${kind}`);

const callImage = async (yaml: string, input: unknown) => {
  const descriptor = parseDescriptor(yaml);
  const sent: unknown[] = [];
  const audit: GateRecord[] = [];
  const error = await describedCall(
    {
      gate: createGate(),
      ctx: {
        tenant: '999888777',
        principal: { kind: 'operator', issuer: 'test', subject: 'ola' },
        task: 't1',
        signal: new AbortController().signal,
        meter: async () => undefined,
        audit: async (record) => {
          audit.push(record);
        },
      },
      target: {
        port: 'operation',
        operation: descriptor.operation,
        model: { kind: 'model', id: 'lab/image' },
        endpoint: 'lab',
        residency: 'norway',
        admission: 'open',
      },
      descriptor,
      endpoint: {
        baseURL: 'https://models.example.test/v1',
        credential: { kind: 'api-key', key: async () => 'k' },
        fetch: async (_url, init) => {
          sent.push(JSON.parse(String(init?.body)));
          return Response.json(imageFixture.response?.body);
        },
      },
      deployment: 'img',
    },
    input,
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  return { error, sent, audit };
};

const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('descriptor fields that would switch off masking or carry media', () => {
  it('a descriptor that sends its input as text passes operation@1', async () => {
    expect(await failedChecks(imageYaml)).toEqual([]);
  });

  it('a descriptor that declares a personal-data field plain fails operation@1', async () => {
    expect(await failedChecks(imageYaml.replaceAll('prompt: text', 'prompt: plain'))).toContain(
      personalDataCheck,
    );
  });

  it('a descriptor that adds a plain or ref input field fails operation@1', async () => {
    expect(await failedChecks(imageField('plain'))).toContain(personalDataCheck);
    expect(await failedChecks(imageField('ref'))).toContain(personalDataCheck);
  });

  for (const [what, value] of [
    ['an https URL', 'https://example.org/cat.png'],
    ['a data URL', `data:image/png;base64,${pngBase64}`],
    ['a base64 image', pngBase64],
  ])
    it(`${what} in a plain input field is refused before anything leaves`, async () => {
      const { error, sent, audit } = await callImage(imageField('plain'), {
        prompt: 'Rediger bildet',
        image: value,
      });
      expect(error).toBeInstanceOf(GateError);
      expect((error as GateError).refusal).toBe('shape');
      expect(sent).toEqual([]);
      expect(audit[0]).toMatchObject({ outcome: 'refused', refusal: 'shape' });
    });
});

describe('media output in descriptors', () => {
  const mediaYaml = (type: string) =>
    imageYaml.replace(
      'images: { array: { object: { b64: plain } } }',
      `images: { array: { object: { b64: { media: ${type} } } } }`,
    );

  it('a descriptor that marks its output as media of any media type passes operation@1', async () => {
    for (const type of ['image/png', 'audio/wav', 'video/mp4', 'application/pdf', 'text/csv'])
      expect(await failedChecks(mediaYaml(type))).toEqual([]);
  });

  it('a descriptor whose media output is not base64 fails operation@1', async () => {
    const descriptor = parseDescriptor(mediaYaml('image/png'));
    const fixture = {
      ...imageFixture,
      response: { body: { data: [{ b64_json: 'ikke base64!' }] } },
      result: { images: [{ b64: 'ikke base64!' }], usage: { requests: 1 } },
    };
    const failed = contractFailures(await operationContract(descriptor, [fixture]));
    expect(failed.map((f) => f.check)).toContain(
      'one-image: the recorded response maps to the typed result',
    );
  });

  it('a descriptor may declare media in its input, which the gate lets out only with consent', () => {
    expect(() => parseDescriptor(imageField('{ media: image/png }'))).not.toThrow();
  });

  it('a media marker names a media type, or a list of them', () => {
    for (const type of ['image', '"image/png; charset=x"'])
      expect(() => parseDescriptor(mediaYaml(type))).toThrow('must be a media type');
  });

  it('media coming back names its media types, never a wildcard', () => {
    expect(() => parseDescriptor(mediaYaml('image/*'))).toThrow('names its media types');
    expect(() => parseDescriptor(mediaYaml('[image/png, image/*]'))).toThrow(
      'names its media types',
    );
  });
});
