import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateError, type MediaRef } from '@genai/kernel';
import { contractFailures, fixturesFor, operationContract } from './contract.js';
import { call, json, png, refused, wav } from './kit.test-utils.js';
import { parseDescriptor } from './descriptor.js';
import { OperationError } from './executor.js';
import { evaluate } from './mapping.js';
import { bundledDescriptorDir, loadDescriptors } from './registry.js';

const testdata = join(import.meta.dirname, 'testdata');
const examples = loadDescriptors(join(testdata, 'descriptors'));
const exampleFixtures = join(testdata, 'fixtures');
const yamlOf = (id: string) => readFileSync(join(testdata, 'descriptors', `${id}.yaml`), 'utf8');
const example = (id: string) => {
  const found = examples.get(id);
  if (!found) throw new Error(`no example ${id}`);
  return found;
};

describe('example descriptors built from primitives', () => {
  for (const descriptor of examples.list())
    it(`${descriptor.id} passes operation@1 against its recorded fixtures`, async () => {
      const fixtures = fixturesFor(exampleFixtures, descriptor.id);
      expect(fixtures.length).toBeGreaterThan(0);
      expect(contractFailures(await operationContract(descriptor, fixtures))).toEqual([]);
    });

  it('a descriptor with one request is read as one step, unchanged', () => {
    for (const descriptor of loadDescriptors(bundledDescriptorDir).list()) {
      expect(descriptor.steps.length).toBeGreaterThanOrEqual(1);
      if (descriptor.resources.length === 0) expect(descriptor.finally).toEqual([]);
    }
    const embed = loadDescriptors(bundledDescriptorDir).get('openai/embeddings@1');
    expect(embed?.steps.map((s) => [s.name, s.request.encoding, s.response.encoding])).toEqual([
      ['call', 'json', 'json'],
    ]);
  });
});

describe('steps', () => {
  const job = () => example('example/transcribe-job@1');
  const audio = { audio: { mediaType: 'audio/wav', data: wav } };

  it('a later step uses a value bound from an earlier answer, only as a path segment of its pattern', async () => {
    const { sent, outcome } = await call(job(), audio, [
      json({ id: 'job_x1', status: 'succeeded' }),
      json({ id: 'job_x1', status: 'succeeded' }),
      { type: 'text/plain', body: 'hei' },
      json({ deleted: true }),
    ]);
    expect(outcome).toEqual({ result: { text: 'hei' } });
    expect(sent.map((s) => `${s.init?.method} ${s.url.pathname}`)).toEqual([
      'POST /base/jobs',
      'GET /base/jobs/job_x1',
      'GET /base/jobs/job_x1/transcript',
      'DELETE /base/jobs/job_x1',
    ]);
  });

  it('an answer URL is never followed: a bound value that is a URL is refused as a path', async () => {
    const yaml = yamlOf('example/transcribe-job@1').replaceAll("'^job_[a-z0-9]+$'", () => "'^.+$'");
    const { sent, outcome } = await call(parseDescriptor(yaml), audio, [
      json({ id: 'https://evil.example/steal', status: 'succeeded' }),
    ]);
    expect('error' in outcome).toBe(true);
    expect(sent.map((s) => s.url.host)).toEqual(['provider.example.test']);
  });

  it('a step repeats until its answer holds, waiting its interval', async () => {
    const { sent, slept } = await call(job(), audio, [
      json({ id: 'job_x1', status: 'queued' }),
      json({ id: 'job_x1', status: 'running' }),
      json({ id: 'job_x1', status: 'running' }, 200, { 'retry-after': '3' }),
      json({ id: 'job_x1', status: 'succeeded' }),
      { type: 'text/plain', body: 'hei' },
      json({ deleted: true }),
    ]);
    expect(sent).toHaveLength(6);
    expect(slept).toEqual([1000, 3000]);
  });

  it('a step that does not finish within its longest duration fails the call, and finally still runs', async () => {
    const replies = [
      json({ id: 'job_x1', status: 'queued' }),
      ...Array.from({ length: 40 }, () => json({ id: 'job_x1', status: 'running' })),
    ];
    const { sent, outcome } = await call(job(), audio, replies);
    expect((outcome as { error: Error }).error.message).toMatch(/did not finish within 30 seconds/);
    expect(sent.at(-1)?.init?.method).toBe('DELETE');
  });

  it('finally steps run when an earlier step fails, and the first failure is kept', async () => {
    const { sent, outcome } = await call(job(), audio, [
      json({ id: 'job_x1', status: 'failed' }),
      json({ id: 'job_x1', status: 'failed' }),
      json({ deleted: true }),
    ]);
    expect((outcome as { error: Error }).error.message).toMatch(/failed is not one of succeeded/);
    expect(sent.map((s) => s.init?.method)).toEqual(['POST', 'GET', 'DELETE']);
  });

  it('a finally step whose values were never bound is skipped', async () => {
    const { sent } = await call(job(), audio, [json({ error: { message: 'nope' } }, 500)]);
    expect(sent).toHaveLength(1);
  });

  it('usage is summed over steps, and an open unit is metered by its name', async () => {
    const { metered } = await call(job(), audio, [
      json({ id: 'job_x1', status: 'succeeded' }),
      json({ id: 'job_x1', status: 'succeeded' }),
      { type: 'text/plain', body: 'hei', headers: { 'x-audio-seconds': '4' } },
      json({ deleted: true }),
    ]);
    expect(metered).toEqual([{ units: { job: 1 }, audioSeconds: 4 }]);
  });

  it('a token exchange is bound as a secret that only the gate places and no exchange records', async () => {
    const descriptor = example('example/token-score@1');
    const { sent, exchanges, outcome } = await call(
      descriptor,
      { text: 'hei', questions: [{ name: 'urgent' }], tags: ['a'] },
      [
        json({ access_token: 'tok-very-secret', expires_in: 60 }),
        json({ answers: [{ name: 'urgent', score: 0.5 }], usage: { tokens: 3 } }),
      ],
    );
    expect('result' in outcome).toBe(true);
    expect(new Headers(sent[0]?.init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('genki-client:connection-key').toString('base64')}`,
    );
    expect(new Headers(sent[1]?.init?.headers).get('authorization')).toBe('Bearer tok-very-secret');
    expect(JSON.stringify(exchanges)).not.toContain('tok-very-secret');
  });

  it('a mapping may not read a secret, only a step may place it', () => {
    const yaml = yamlOf('example/token-score@1').replace(
      "prompt: { $concat: ['Vurder: ', $input.text] }",
      'prompt: $steps.token.access',
    );
    expect(refused(yaml)).toMatch(/a secret only the gate may place/);
  });
});

describe('encodings', () => {
  it('a query credential is placed by the gate and redacted from the recorded exchange', async () => {
    const { sent, exchanges } = await call(
      example('example/ocr@1'),
      { image: png, language: 'nb' },
      [
        {
          type: 'application/x-ndjson',
          headers: { 'x-pages': '1' },
          body: '{"page":1,"text":"en"}\n',
        },
      ],
    );
    expect(sent[0]?.url.searchParams.get('key')).toBe('connection-key');
    expect(JSON.stringify(exchanges)).not.toContain('connection-key');
    expect(exchanges[0]?.request?.query).toEqual({ 'api-version': '2026-11-01', language: 'nb' });
  });

  it('a binary request body is the media itself, with its media type', async () => {
    const { sent } = await call(example('example/ocr@1'), { image: png, language: 'en' }, [
      {
        type: 'application/x-ndjson',
        headers: { 'x-pages': '1' },
        body: '{"page":1,"text":"a"}\n',
      },
    ]);
    const body = sent[0]?.init?.body as Blob;
    expect(body.type).toBe('image/png');
    expect(Buffer.from(await body.arrayBuffer()).toString('base64')).toBe(png);
  });

  it('a multipart request sends media as a file part named after its media type', async () => {
    const { sent } = await call(example('example/edit-image@1'), { picture: png, prompt: 'blå' }, [
      { type: 'image/png', body: Buffer.from(png, 'base64') },
    ]);
    const form = sent[0]?.init?.body as FormData;
    const file = form.get('picture') as File;
    expect([file.name, file.type, form.get('prompt'), form.get('size')]).toEqual([
      'picture.png',
      'image/png',
      'blå',
      'small',
    ]);
  });

  it('a binary answer becomes a media blob of the run', async () => {
    const { outcome, audit } = await call(
      example('example/edit-image@1'),
      { picture: png, prompt: 'blå' },
      [{ type: 'image/png', body: Buffer.from(png, 'base64') }],
    );
    expect(outcome).toMatchObject({
      result: { picture: { kind: 'media', mediaType: 'image/png', bytes: 70, path: 'kept/1' } },
    });
    expect(audit[0]).toMatchObject({ outcome: 'ok', mediaBytes: 70 });
  });

  it('an answer whose content type differs from the declared one fails the call', async () => {
    const { outcome, audit } = await call(
      example('example/edit-image@1'),
      { picture: png, prompt: 'blå' },
      [{ type: 'image/jpeg', body: Buffer.from(png, 'base64') }],
    );
    expect((outcome as { error: Error }).error.message).toMatch(
      /declares a image\/png answer, and the provider answered image\/jpeg/,
    );
    expect(audit[0]?.outcome).toBe('failed');
  });

  it('a json answer sent as text fails the call', async () => {
    const { outcome } = await call(
      example('example/token-score@1'),
      { text: 'hei', questions: [{ name: 'a' }], tags: [] },
      [{ type: 'text/plain', body: '{"access_token":"x","expires_in":1}' }],
    );
    expect((outcome as { error: Error }).error.message).toMatch(/declares a json answer/);
  });
});

describe('errors and checks', () => {
  const score = () => example('example/token-score@1');
  const input = { text: 'hei', questions: [{ name: 'urgent' }, { name: 'polite' }], tags: [] };
  const token = json({ access_token: 'tok', expires_in: 60 });
  const answered = json({
    answers: [
      { name: 'urgent', score: 0.1 },
      { name: 'polite', score: 0.9 },
    ],
    usage: { tokens: 1 },
  });

  it("429 with Retry-After is honoured up to the step's cap", async () => {
    const { outcome, slept } = await call(score(), input, [
      token,
      json({ error: { message: 'slow' } }, 429, { 'retry-after': '2' }),
      answered,
    ]);
    expect('result' in outcome).toBe(true);
    expect(slept).toEqual([2000]);
  });

  it("a Retry-After beyond the step's cap fails the call as rate limited without waiting", async () => {
    const { outcome, slept } = await call(score(), input, [
      token,
      json({ error: { message: 'slow' } }, 429, { 'retry-after': '120' }),
    ]);
    expect((outcome as { error: OperationError }).error).toMatchObject({
      status: 429,
      kind: 'rate-limited',
    });
    expect(slept).toEqual([]);
  });

  it("a provider's error envelope maps to Genki's error kind and message", async () => {
    const { outcome } = await call(score(), input, [
      token,
      json({ error: { detail: 'questions must be lower case' } }, 422),
    ]);
    expect((outcome as { error: OperationError }).error).toMatchObject({
      status: 422,
      kind: 'invalid',
      message: 'questions must be lower case',
    });
  });

  it('an answer that fails a same-names check fails the call', async () => {
    const { outcome, audit } = await call(score(), input, [
      token,
      json({ answers: [{ name: 'urgent', score: 0.1 }], usage: { tokens: 1 } }),
    ]);
    expect((outcome as { error: Error }).error.message).toMatch(/names urgent, not polite, urgent/);
    expect(audit[0]?.outcome).toBe('failed');
  });

  it('an answer that fails a count check fails the call', async () => {
    const { outcome } = await call(example('example/ocr@1'), { image: png, language: 'nb' }, [
      { type: 'application/x-ndjson', headers: { 'x-pages': '0' }, body: '' },
    ]);
    expect((outcome as { error: Error }).error.message).toMatch(/has 0 items, fewer than 1/);
  });
});

describe('media input and consent (#326)', () => {
  const edit = () => example('example/edit-image@1');
  const reply = [{ type: 'image/png', body: Buffer.from(png, 'base64') }];

  it('media input without consent is refused before anything leaves', async () => {
    const { outcome, sent, audit } = await call(edit(), { picture: png, prompt: 'x' }, reply, {
      synthetic: false,
    });
    expect((outcome as { error: GateError }).error).toBeInstanceOf(GateError);
    expect((outcome as { error: GateError }).error.refusal).toBe('media');
    expect(sent).toEqual([]);
    expect(audit[0]).toMatchObject({ outcome: 'refused', refusal: 'media' });
  });

  it('media input leaves with consent for its media type, and the gate records type, size and SHA-256', async () => {
    const { outcome, audit } = await call(edit(), { picture: png, prompt: 'x' }, reply, {
      synthetic: false,
      unmaskedMedia: ['image/*'],
    });
    expect('result' in outcome).toBe(true);
    expect(audit[0]?.mediaInput).toEqual([
      {
        path: 'picture',
        mediaType: 'image/png',
        bytes: 70,
        sha256: '497790947d4666760ce38f3c00e852c71fdb66cae849bae8e9ede352719e1581',
      },
    ]);
  });

  it('consent for one media type does not cover another', async () => {
    const { outcome } = await call(edit(), { picture: png, prompt: 'x' }, reply, {
      synthetic: false,
      unmaskedMedia: ['audio/*'],
    });
    expect((outcome as { error: GateError }).error.refusal).toBe('media');
  });

  it('media kept by the run is read through the gate, and only for its own tenant', async () => {
    const ref = (tenant: string): MediaRef => ({
      kind: 'media',
      mediaType: 'image/png',
      bytes: 70,
      sha256: '',
      tenant,
      path: 'runs/t0/media/1',
    });
    const read = () => Buffer.from(png, 'base64');
    const own = await call(edit(), { picture: ref('999888777'), prompt: 'x' }, reply, {
      readMedia: read,
    });
    expect('result' in own.outcome).toBe(true);
    const other = await call(edit(), { picture: ref('111222333'), prompt: 'x' }, reply, {
      readMedia: read,
    });
    expect((other.outcome as { error: GateError }).error.refusal).toBe('media');
    expect(other.sent).toEqual([]);
  });
});

describe('the mapping language', () => {
  const scope = {
    response: { items: [{ name: 'a' }, { name: 'b' }], done: 'yes' },
    input: { tags: ['x', 'y'], fast: false },
  };

  it('indexing reads one item of a list', () => {
    expect(evaluate('$response.items.1.name', scope)).toBe('b');
    expect(evaluate('$response.items.5', scope)).toBeUndefined();
  });

  it('$concat joins text, or lists when every part is a list', () => {
    expect(evaluate({ $concat: ['Hei ', '$response.items.0.name', 1] }, scope)).toBe('Hei a1');
    expect(evaluate({ $concat: ['$input.tags', ['z']] }, scope)).toEqual(['x', 'y', 'z']);
  });

  it('$join puts text between the items of a list', () => {
    expect(evaluate({ $join: ['$input.tags', ' + '] }, scope)).toBe('x + y');
  });

  it('$if chooses by a test, or by the test equalling a value', () => {
    expect(evaluate({ $if: { test: '$input.fast', then: 'quick', else: 'slow' } }, scope)).toBe(
      'slow',
    );
    expect(
      evaluate({ $if: { test: '$response.done', equals: ['yes', 'ok'], then: 1, else: 2 } }, scope),
    ).toBe(1);
  });
});

const job = () => yamlOf('example/transcribe-job@1');
const ocr = () => yamlOf('example/ocr@1');
const edit = () => yamlOf('example/edit-image@1');

describe('what never changes: hostile descriptors are refused', () => {
  it('an unclassified field is refused at load', () => {
    expect(
      refused(ocr().replace('  query:\n    object:\n      language: { enum: [nb, en] }\n', '')),
    ).toMatch(/maps language without a class/);
    expect(refused(ocr().replace('      x-hint?: text', '      x-other?: text'))).toMatch(
      /x-hint has no class/,
    );
    expect(
      refused(
        job().replace(
          "      job: { from: $response.id, class: { issued: '^job_[a-z0-9]+$' } }",
          '      job: { from: $response.id }',
        ),
      ),
    ).toMatch(/class/);
    expect(
      refused(
        edit().replace(
          '  request:\n    object:\n      picture: { media: image/png }\n      prompt: text\n      size: { enum: [small, large] }\n',
          '',
        ),
      ),
    ).toMatch(/without wire.request/);
  });

  it('a request to another host is refused at load', () => {
    expect(refused(edit().replace('path: /edits', 'path: //evil.example/edits'))).toMatch(
      /kept out of descriptors/,
    );
    expect(refused(edit().replace('path: /edits', 'path: /../edits'))).toMatch(
      /kept out of descriptors/,
    );
    expect(
      refused(
        edit().replace(
          '    prompt: $input.prompt',
          "    prompt: { $concat: ['https://evil.example/?q=', $input.prompt] }",
        ),
      ),
    ).toMatch(/names no URL/);
  });

  it('a path from input is refused at load', () => {
    expect(refused(edit().replace('path: /edits', 'path: /edits/{input.prompt}'))).toMatch(
      /input never chooses a path/,
    );
    expect(
      refused(
        job().replace(
          "      job: { from: $response.id, class: { issued: '^job_[a-z0-9]+$' } }",
          '      job: { from: $response.id, class: plain }',
        ),
      ),
    ).toMatch(/bound as an issued id/);
  });

  it('a model from input is refused at load', () => {
    expect(
      refused(job().replace('        model: $deployment', '        model: $input.language')),
    ).toMatch(/must be \$deployment; the input never chooses the model/);
    expect(
      refused(
        ocr()
          .replace(
            '    language: $input.language',
            '    language: $input.language\n    model: $input.language',
          )
          .replace(
            '      language: { enum: [nb, en] }\n  headers',
            '      language: { enum: [nb, en] }\n      model: plain\n  headers',
          ),
      ),
    ).toMatch(/model: must be \$deployment/);
  });

  it('a credential from input is refused at load', () => {
    expect(
      refused(
        ocr()
          .replace('    x-hint: $input.hint', '    authorization: $input.hint')
          .replace('      x-hint?: text', '      authorization?: text'),
      ),
    ).toMatch(/header authorization is set by the gate/);
    expect(
      refused(
        yamlOf('example/token-score@1').replace(
          'secret: $steps.token.access',
          'secret: $steps.input.text',
        ),
      ),
    ).toMatch(/auth.secret must be a value an earlier step binds as secret/);
    expect(
      refused(ocr().replace('    language: $input.language', '    key: $input.language')),
    ).toMatch(/request.query.key is where the credential goes/);
  });

  it('a ref from input is refused at load', () => {
    expect(
      refused(
        job().replace(
          "      job: { from: $response.id, class: { issued: '^job_[a-z0-9]+$' } }",
          () => "      job: { from: $input.language, class: { issued: '^job_[a-z0-9]+$' } }",
        ),
      ),
    ).toMatch(/reads \$input, which is not available here/);
    expect(
      refused(
        edit()
          .replace(
            '    prompt: $input.prompt',
            '    prompt: $input.prompt\n    file_id: $input.prompt',
          )
          .replace(
            '      prompt: text\n      size',
            '      prompt: text\n      file_id: plain\n      size',
          ),
      ),
    ).toMatch(/a provider object id comes only from a value bound in an earlier step/);
  });

  it('a field that would carry a URL is refused at load, since input never names a URL', () => {
    expect(
      refused(
        edit()
          .replace(
            '    prompt: $input.prompt',
            '    prompt: $input.prompt\n    image_url: $input.prompt',
          )
          .replace(
            '      prompt: text\n      size',
            '      prompt: text\n      image_url: text\n      size',
          ),
      ),
    ).toMatch(/may not carry image_url; input never names a URL/);
  });

  it('media goes out only in json, multipart or binary bodies', () => {
    expect(
      refused(edit().replace('  encoding: multipart\n  parts:', '  encoding: form\n  body:')),
    ).toMatch(/form request holds single values only/);
  });
});
