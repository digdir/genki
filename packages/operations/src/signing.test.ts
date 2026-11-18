import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractFailures, operationContract, type OperationFixture } from './contract.js';
import { parseDescriptor } from './descriptor.js';
import { call, json, refused } from './kit.test-utils.js';
import { sha256Of } from './module.js';
import { composer, namedKeySigner, type Piece } from './wasm.test-utils.js';

const at = new Date('2026-11-06T10:00:00Z');
const errorOf = (outcome: unknown) => (outcome as { error: Error }).error;
const hmac = (key: string | Buffer, data: string | Uint8Array) =>
  createHmac('sha256', key).update(data).digest();
const hex = (key: string | Buffer, data: string | Uint8Array) => hmac(key, data).toString('hex');
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Parts {
  auth?: string;
  keys?: string;
  input?: string;
  request?: string;
  wire?: string;
  response?: string;
  emits?: string;
  headers?: string;
  result?: string;
  output?: string;
  step?: string;
}

const yamlOf = (bytes: Uint8Array, p: Parts = {}) => `
id: example/signed@1
operation: signed
status: described
summary: A made-up API that wants every request signed.
api: { family: example, version: '1', headers: { x-api-version: '7' } }
${p.auth ?? 'auth: { signedBy: module }'}
modules:
  signer:
    sha256: ${sha256Of(bytes)}
    keys: ${p.keys ?? '[connection]'}
input: ${p.input ?? '{ object: { item: text } }'}
output: ${p.output ?? '{ object: { status: plain } }'}
result: ${p.result ?? '{ status: $response.status }'}
steps:
  - name: place
${p.step ? `    ${p.step}\n` : ''}    request: ${p.request ?? '{ method: POST, path: /orders, body: { item: $input.item } }'}
    module:
      use: signer
      emits: ${p.emits ?? "{ sig: { ref: '^[ -~]{1,500}$' } }"}
      headers: ${p.headers ?? '{ x-signature: sig }'}
${p.response ?? '    usage: { request: 1 }'}
    wire:
${p.wire ?? '      request: { object: { item: text } }\n      response: { object: { status: plain } }'}
`;

const run = async (
  bytes: Uint8Array,
  parts: Parts,
  input: unknown = { item: 'pen' },
  options: Parameters<typeof call>[3] = {},
  replies = [json({ status: 'placed' })],
) =>
  call(parseDescriptor(yamlOf(bytes, parts)), input, replies, {
    ...options,
    endpoint: { modules: () => bytes, now: () => at, ...options.endpoint },
  });

const headersOf = (sent: { init?: RequestInit | undefined }[], n = 0) =>
  new Headers(sent[n]?.init?.headers);

const leaks = (
  sent: { url: URL; init?: RequestInit | undefined }[],
  exchanges: unknown,
  secrets: string[],
) =>
  secrets.filter(
    (secret) =>
      sent.some(
        (r) =>
          r.url.href.includes(secret) ||
          JSON.stringify(r.init?.headers).includes(secret) ||
          (typeof r.init?.body === 'string' && r.init.body.includes(secret)),
      ) || JSON.stringify(exchanges).includes(secret),
  );

const signer = (pieces: Piece[]) => composer({ sig: pieces });
const echo = (input: string) => signer([{ input }]);

describe('a module that signs sets Authorization (D)', () => {
  const pieces: Piece[] = [
    { text: 'HMAC ' },
    { hmac: { key: 'connection', of: [{ input: 'method' }, { text: '\n' }, { input: 'path' }] } },
  ];

  it('a module may set Authorization when the key only signs', async () => {
    const bytes = signer(pieces);
    const { outcome, sent, exchanges } = await run(bytes, {
      emits: "{ sig: { ref: '^HMAC [0-9a-f]{64}$' } }",
      headers: '{ Authorization: sig }',
    });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('authorization')).toBe(
      `HMAC ${hex('connection-key', 'POST\n/base/orders')}`,
    );
    expect(leaks(sent, exchanges, ['connection-key'])).toEqual([]);
  });

  it("a module sets Authorization only when the descriptor's auth is signedBy: module", () => {
    const yaml = yamlOf(signer(pieces), {
      auth: 'auth: { header: x-key }',
      headers: '{ authorization: sig }',
    });
    expect(refused(yaml)).toMatch(/sets authorization only for a key that only signs/);
  });

  it('a module does not set Authorization on a step that places an exchanged secret', () => {
    const bytes = signer(pieces);
    const yaml = yamlOf(bytes, { headers: '{ authorization: sig }' }).replace(
      '  - name: place\n',
      () => `  - name: token
    request: { method: POST, path: /token, body: { item: $input.item } }
    module: { use: signer, emits: { sig: { ref: '^[ -~]{1,500}$' } }, headers: { x-signature: sig } }
    wire:
      request: { object: { item: text } }
      response: { object: { token: opaque } }
    bind:
      access: { from: $response.token, class: secret }
  - name: place
    auth: { header: x-token, secret: $steps.token.access }
`,
    );
    expect(refused(yaml)).toMatch(/places no other secret/);
  });

  it('every other reserved header stays closed to a module, even when the key only signs', () => {
    for (const header of ['x-api-key', 'cookie', 'host', 'content-type', 'proxy-authorization'])
      expect(refused(yamlOf(signer(pieces), { headers: `{ ${header}: sig }` }))).toMatch(
        /credentials come from the endpoint/,
      );
  });
});

describe('what a signing module reads (D)', () => {
  it('a module reads the host the request goes to', async () => {
    const { outcome, sent } = await run(echo('host'), { headers: '{ x-signed-host: sig }' });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-signed-host')).toBe('provider.example.test');
  });

  it('a module reads the outgoing headers it signs over, canonical and sorted', async () => {
    const bytes = composer({
      names: [{ input: 'header_names' }],
      sig: [{ hmac: { key: 'connection', of: [{ input: 'headers' }] } }],
    });
    const { outcome, sent } = await run(bytes, {
      emits: "{ names: { ref: '^[a-z;-]{1,500}$' }, sig: { ref: '^[0-9a-f]{64}$' } }",
      headers: '{ x-signed-headers: names, x-signature: sig }',
      request:
        '{ method: POST, path: /orders, body: { item: $input.item }, headers: { X-Item: $input.item } }',
      wire: `      headers: { object: { X-Item: text } }
      request: { object: { item: text } }
      response: { object: { status: plain } }`,
    });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-signed-headers')).toBe(
      'accept;content-type;host;x-api-version;x-item',
    );
    expect(headersOf(sent).get('x-signature')).toBe(
      hex(
        'connection-key',
        'accept:application/json\ncontent-type:application/json\nhost:provider.example.test\nx-api-version:7\nx-item:pen\n',
      ),
    );
  });

  it('a module reads one outgoing header as header.<name>', async () => {
    const { outcome, sent } = await run(echo('header.x-api-version'), {
      headers: '{ x-signed-version: sig }',
    });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-signed-version')).toBe('7');
  });

  it('a header named twice in different cases reaches the module as fetch sends it, one combined value', async () => {
    const bytes = composer({
      names: [{ input: 'header_names' }],
      version: [{ input: 'header.x-api-version' }],
    });
    const { outcome, sent } = await run(bytes, {
      emits: "{ names: { ref: '^[a-z;-]{1,500}$' }, version: { ref: '^[0-9, ]{1,20}$' } }",
      headers: '{ x-signed-headers: names, x-signed-version: version }',
      request:
        '{ method: POST, path: /orders, body: { item: $input.item }, headers: { X-API-Version: "8" } }',
      wire: `      headers: { object: { X-API-Version: { enum: ["8"] } } }
      request: { object: { item: text } }
      response: { object: { status: plain } }`,
    });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-api-version')).toBe('7, 8');
    expect(headersOf(sent).get('x-signed-headers')).toBe('accept;content-type;host;x-api-version');
    expect(headersOf(sent).get('x-signed-version')).toBe('7, 8');
  });

  it('a form body reaches the module with the content type fetch sends for it', async () => {
    const bytes = composer({
      type: [{ input: 'header.content-type' }],
      sig: [{ hmac: { key: 'connection', of: [{ input: 'body' }] } }],
    });
    const { outcome, sent } = await run(bytes, {
      emits: "{ type: { ref: '^[a-z/;=A-Z0-9-]{1,80}$' }, sig: { ref: '^[0-9a-f]{64}$' } }",
      headers: '{ x-signed-type: type, x-signature: sig }',
      request: '{ method: POST, path: /orders, encoding: form, body: { item: $input.item } }',
    });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
    expect(headersOf(sent).get('x-signed-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
    expect(headersOf(sent).get('x-signature')).toBe(hex('connection-key', 'item=pen'));
  });

  it('the headers a module reads never include a secret the gate places', async () => {
    const bytes = signer([{ input: 'header_names' }]);
    const yaml = yamlOf(bytes, { auth: 'auth: { header: x-key }', keys: '[]' }).replace(
      '  - name: place\n',
      () => `  - name: token
    request: { method: POST, path: /token, body: { item: $input.item } }
    wire:
      request: { object: { item: text } }
      response: { object: { token: opaque } }
    bind:
      access: { from: $response.token, class: secret }
  - name: place
    auth: { header: authorization, scheme: Bearer, secret: $steps.token.access }
`,
    );
    const { outcome, sent } = await call(
      parseDescriptor(yaml),
      { item: 'pen' },
      [json({ token: 'tok-very-secret' }), json({ status: 'placed' })],
      { endpoint: { modules: () => bytes, now: () => at } },
    );
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent, 1).get('authorization')).toBe('Bearer tok-very-secret');
    expect(headersOf(sent, 1).get('x-signature')).toBe('accept;content-type;host;x-api-version');
  });
});

describe('a module signs any body the gate sends (D)', () => {
  const binary = {
    input: '{ object: { file: { media: image/png } } }',
    request: '{ method: PUT, path: /objects, encoding: binary, body: $input.file }',
    wire: '      request: { media: image/png }\n      response: { object: { status: plain } }',
  };

  it('a module signs a binary body', async () => {
    const bytes = signer([{ hmac: { key: 'connection', of: [{ input: 'body' }] } }]);
    const { outcome, sent } = await run(bytes, binary, { file: png });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-signature')).toBe(
      hex('connection-key', Buffer.from(png, 'base64')),
    );
  });

  it('a module signs a body over its input cap through the body_sha256 the host computes', async () => {
    const large = Buffer.alloc(1_200_000, 7);
    large.set(Buffer.from(png, 'base64'));
    const bytes = signer([
      { input: 'body_sha256' },
      { text: ':' },
      { hmac: { key: 'connection', of: [{ input: 'body_sha256' }] } },
    ]);
    const { outcome, sent } = await run(
      bytes,
      binary,
      { file: large.toString('base64') },
      { maxMediaBytes: 2_000_000 },
    );
    expect(outcome).toEqual({ result: { status: 'placed' } });
    const digest = createHash('sha256').update(large).digest('hex');
    expect(headersOf(sent).get('x-signature')).toBe(`${digest}:${hex('connection-key', digest)}`);
  });

  it('a multipart body is serialised before it is signed, so the module signs the bytes that are sent', async () => {
    const bytes = signer([{ hmac: { key: 'connection', of: [{ input: 'body' }] } }]);
    const { outcome, sent } = await run(
      bytes,
      {
        input: '{ object: { file: { media: image/png }, item: text } }',
        request:
          '{ method: POST, path: /submit, encoding: multipart, parts: { file: $input.file, item: $input.item } }',
        wire: '      request: { object: { file: { media: image/png }, item: text } }\n      response: { object: { status: plain } }',
      },
      { file: png, item: 'pen' },
    );
    expect(outcome).toEqual({ result: { status: 'placed' } });
    const body = sent[0]?.init?.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(headersOf(sent).get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(Buffer.from(body).toString('latin1')).toContain('name="item"');
    expect(headersOf(sent).get('x-signature')).toBe(hex('connection-key', body));
  });

  it('a signed multipart request is recorded by its parts, not as the bytes that were signed', async () => {
    const bytes = signer([{ hmac: { key: 'connection', of: [{ input: 'body' }] } }]);
    const { exchanges } = await run(
      bytes,
      {
        input: '{ object: { file: { media: image/png }, item: text } }',
        request:
          '{ method: POST, path: /submit, encoding: multipart, parts: { file: $input.file, item: $input.item } }',
        wire: '      request: { object: { file: { media: image/png }, item: text } }\n      response: { object: { status: plain } }',
      },
      { file: png, item: 'pen' },
    );
    expect(exchanges[0]?.request?.body).toMatchObject({ item: 'pen' });
  });

  it('a module cannot sign a step whose credential is a form field, since it reads the body', () => {
    const yaml = yamlOf(echo('host'), {
      auth: 'auth: { form: api_key }',
      keys: '[]',
      request: '{ method: POST, path: /orders, encoding: form, body: { item: $input.item } }',
    });
    expect(refused(yaml)).toMatch(/cannot sign a step whose credential is a form field/);
  });

  it('a module signs a request whose answer is streamed', async () => {
    const bytes = signer([{ hmac: { key: 'connection', of: [{ input: 'body' }] } }]);
    const { outcome, sent } = await run(
      bytes,
      {
        output: '{ object: { answer: text } }',
        result: '{ answer: $response.text }',
        response: `    response:
      stream:
        framing: sse
        events:
          token: { shape: { object: { text: text } }, delta: $event.text }
          finished: { shape: { object: {} }, done: true }
    usage: { request: 1 }`,
        wire: '      request: { object: { item: text } }',
      },
      { item: 'pen' },
      {},
      [
        {
          type: 'text/event-stream',
          body: 'event: token\ndata: {"text":"ok"}\n\nevent: finished\ndata: {}\n\n',
        },
      ],
    );
    expect(outcome).toEqual({ result: { answer: 'ok' } });
    expect(headersOf(sent).get('x-signature')).toBe(
      hex('connection-key', String(sent[0]?.init?.body)),
    );
  });

  it('a module still does not sign a live session', () => {
    const yaml = yamlOf(echo('host'), {
      request: '{ method: GET, path: /live }',
      wire: '      query: { object: {} }',
      response: `    websocket:
      longestSeconds: 60
      client: { events: { say: { shape: { object: { text: text } } } } }
      server: { events: { done: { shape: { object: {} }, done: true } } }`,
    });
    expect(refused(yaml)).toMatch(/a module signs a request, not a session/);
  });
});

describe('connection settings and named keys (D)', () => {
  const settings = { keyId: 'AKID-7', region: 'eu-north-1' };
  const withSetting = {
    request:
      '{ method: POST, path: /orders, body: { item: $input.item }, query: { region: $connection.region }, headers: { x-key-id: $connection.keyId } }',
    wire: `      query: { object: { region: plain } }
      headers: { object: { x-key-id: plain } }
      request: { object: { item: text } }
      response: { object: { status: plain } }`,
  };

  it('a connection setting fills a header and the query', async () => {
    const { outcome, sent, exchanges } = await run(echo('host'), withSetting, undefined, {
      endpoint: { settings },
    });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-key-id')).toBe('AKID-7');
    expect(sent[0]?.url.searchParams.get('region')).toBe('eu-north-1');
    expect(exchanges[0]).toMatchObject({ settings });
  });

  it('an exchange records no settings when the connection has none', async () => {
    const { exchanges } = await run(echo('host'), {});
    expect(exchanges[0]).not.toHaveProperty('settings');
  });

  it('a descriptor reads a connection setting only as $connection.<name>', () => {
    for (const path of ['$connection', '$connection.a.b', '$connection.Key'])
      expect(
        refused(
          yamlOf(echo('host'), {
            request: `{ method: POST, path: /orders, body: { item: $input.item }, headers: { x-a: ${path} } }`,
            wire: `      headers: { object: { x-a: plain } }
      request: { object: { item: text } }
      response: { object: { status: plain } }`,
          }),
        ),
      ).toMatch(/is not a connection setting/);
  });

  it('a call fails before its first request when a later step reads a setting the connection lacks', async () => {
    const bytes = echo('host');
    const yaml = yamlOf(bytes, withSetting).replace(
      '  - name: place\n',
      () => `  - name: first
    request: { method: POST, path: /first, body: { item: $input.item } }
    module: { use: signer, emits: { sig: { ref: '^[ -~]{1,500}$' } }, headers: { x-signature: sig } }
    wire:
      request: { object: { item: text } }
      response: { object: { ok: plain } }
  - name: place
`,
    );
    const { outcome, sent } = await call(
      parseDescriptor(yaml),
      { item: 'pen' },
      [json({ ok: 'yes' }), json({ status: 'placed' })],
      { endpoint: { modules: () => bytes, now: () => at, settings: { keyId: 'AKID-7' } } },
    );
    expect(errorOf(outcome).message).toMatch(/the connection has no setting region/);
    expect(sent).toEqual([]);
  });

  it('a call whose connection lacks a setting the descriptor reads fails before anything leaves', async () => {
    const { outcome, sent } = await run(echo('host'), withSetting, undefined, {
      endpoint: { settings: { keyId: 'AKID-7' } },
    });
    expect(errorOf(outcome).message).toMatch(/the connection has no setting region/);
    expect(sent).toEqual([]);
  });

  it('a connection setting never fills the path, so it cannot choose where a request goes', () => {
    expect(
      refused(
        yamlOf(echo('host'), { request: "{ method: POST, path: '/orders/{connection.keyId}' }" }),
      ),
    ).toMatch(/input never chooses a path/);
  });

  it('a connection setting never fills a request body', () => {
    expect(
      refused(
        yamlOf(echo('host'), {
          request: '{ method: POST, path: /orders, body: { item: $connection.keyId } }',
        }),
      ),
    ).toMatch(/reads \$connection/);
  });

  it('a module reads the connection settings', async () => {
    const bytes = signer([
      { input: 'connection.keyId' },
      { text: '/' },
      { input: 'connection.region' },
    ]);
    const { outcome, sent } = await run(bytes, {}, undefined, { endpoint: { settings } });
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-signature')).toBe('AKID-7/eu-north-1');
  });

  it('a module signs with a named key of the connection, and no key reaches the request', async () => {
    const bytes = signer([{ hmac: { key: 'connection.signing', of: [{ input: 'body' }] } }]);
    const { outcome, sent, exchanges } = await run(
      bytes,
      { keys: '[connection, connection.signing]' },
      undefined,
      { endpoint: { keys: { signing: async () => 'extra-signing-key' } } },
    );
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-signature')).toBe(
      hex('extra-signing-key', String(sent[0]?.init?.body)),
    );
    expect(leaks(sent, exchanges, ['extra-signing-key', 'connection-key'])).toEqual([]);
  });

  it('a call fails before anything leaves when the connection lacks a key the module takes', async () => {
    const bytes = signer([{ hmac: { key: 'connection.signing', of: [{ input: 'body' }] } }]);
    const { outcome, sent } = await run(bytes, { keys: '[connection, connection.signing]' });
    expect(errorOf(outcome).message).toMatch(/the connection has no key connection.signing/);
    expect(sent).toEqual([]);
  });

  it('a module key is the connection key or one of its named keys', () => {
    expect(refused(yamlOf(echo('host'), { keys: '[connection, other.signing]' }))).toMatch(
      /connection, or connection.<key name>/,
    );
  });

  it('a module derives a signing key in the host, so neither the secret nor a derived key enters the module', async () => {
    const bytes = signer([
      {
        derive: { key: 'connection.signing', prefix: 'AWS4', of: [{ text: '20261106' }], as: 'k1' },
      },
      { derive: { key: 'k1', prefix: '', of: [{ input: 'connection.region' }], as: 'k2' } },
      { derive: { key: 'k2', prefix: '', of: [{ text: 'svc' }], as: 'k3' } },
      { derive: { key: 'k3', prefix: '', of: [{ text: 'aws4_request' }], as: 'k4' } },
      { hmac: { key: 'k4', of: [{ input: 'body_sha256' }] } },
    ]);
    const { outcome, sent, exchanges } = await run(
      bytes,
      { keys: '[connection, connection.signing]' },
      undefined,
      { endpoint: { settings, keys: { signing: async () => 'wJalrXUtnFEMI' } } },
    );
    expect(outcome).toEqual({ result: { status: 'placed' } });
    const k1 = hmac('AWS4wJalrXUtnFEMI', '20261106');
    const k4 = hmac(hmac(hmac(k1, 'eu-north-1'), 'svc'), 'aws4_request');
    const digest = createHash('sha256').update(String(sent[0]?.init?.body)).digest('hex');
    expect(headersOf(sent).get('x-signature')).toBe(hex(k4, digest));
    expect(leaks(sent, exchanges, ['wJalrXUtnFEMI', 'connection-key'])).toEqual([]);
  });

  it('a provider error body that echoes a named key or a derived signature is redacted before it is stored', async () => {
    const bytes = signer([
      {
        derive: { key: 'connection.signing', prefix: 'AWS4', of: [{ text: '20261106' }], as: 'k1' },
      },
      { hmac: { key: 'k1', of: [{ input: 'body' }] } },
    ]);
    const signature = hex(
      hmac('AWS4extra-signing-key', '20261106'),
      JSON.stringify({ item: 'pen' }),
    );
    const { outcome, sent, exchanges } = await run(
      bytes,
      { keys: '[connection, connection.signing]' },
      undefined,
      { endpoint: { keys: { signing: async () => 'extra-signing-key' } } },
      [json({ error: { message: `bad signature ${signature} for key extra-signing-key` } }, 403)],
    );
    expect(headersOf(sent).get('x-signature')).toBe(signature);
    const error = errorOf(outcome) as Error & { provider?: { status: number; body?: string } };
    expect(error.provider).toEqual({
      status: 403,
      body: expect.stringContaining('bad signature [redacted] for key [redacted]'),
    });
    expect(leaks(sent, exchanges, ['extra-signing-key', 'connection-key'])).toEqual([]);
    expect(`${error.message}${error.provider?.body ?? ''}`).not.toContain(signature);
  });

  it('a derived key never replaces a key the module was given', async () => {
    const bytes = signer([
      { derive: { key: 'connection', prefix: 'x', of: [{ text: 'y' }], as: 'connection' } },
      { hmac: { key: 'connection', of: [{ input: 'body' }] } },
    ]);
    const { outcome, sent } = await run(bytes, {});
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-signature')).toBe(
      hex('connection-key', String(sent[0]?.init?.body)),
    );
  });

  it('a derive with a prefix over 64 bytes derives nothing, so the signature under it is empty', async () => {
    const bytes = signer([
      { derive: { key: 'connection', prefix: 'x'.repeat(65), of: [{ text: 'y' }], as: 'k1' } },
      { hmac: { key: 'k1', of: [{ input: 'body' }] } },
    ]);
    const { outcome, sent } = await run(bytes, {});
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(headersOf(sent).get('x-signature')).toBe('0'.repeat(64));
  });

  it('a named key the connection does not hold is never found through the object prototype', async () => {
    const bytes = signer([{ hmac: { key: 'connection.toString', of: [{ input: 'body' }] } }]);
    const { outcome, sent } = await run(bytes, { keys: '[connection, connection.toString]' });
    expect(errorOf(outcome).message).toMatch(/the connection has no key connection.toString/);
    expect(sent).toEqual([]);
  });

  it('the checked-in named-key test module is the one the builder makes', () => {
    const file = join(import.meta.dirname, 'testdata', 'modules', 'named-key-signer.wasm');
    expect(new Uint8Array(readFileSync(file))).toEqual(namedKeySigner());
  });

  it('a module derives at most eight keys', async () => {
    const bytes = signer(
      Array.from({ length: 9 }, (_, i): Piece => ({
        derive: { key: 'connection', prefix: '', of: [{ text: 'd' }], as: `k${i}` },
      })),
    );
    const { outcome, sent } = await run(bytes, {});
    expect(errorOf(outcome).message).toMatch(/derived too many keys/);
    expect(sent).toEqual([]);
  });

  it('operation@1 replays a session fixture with the settings it records', async () => {
    const dir = join(import.meta.dirname, 'testdata');
    const yaml = readFileSync(join(dir, 'descriptors', 'example', 'chat-session@1.yaml'), 'utf8')
      .replace(
        '      path: /live\n',
        '      path: /live\n      headers:\n        x-key-id: $connection.keyId\n',
      )
      .replace(
        '      query:\n        object: {}\n',
        '      query:\n        object: {}\n      headers:\n        object:\n          x-key-id: plain\n',
      );
    const descriptor = parseDescriptor(yaml);
    const recorded = JSON.parse(
      readFileSync(join(dir, 'fixtures', 'example', 'chat-session@1', 'one-turn.json'), 'utf8'),
    ) as OperationFixture & { session: { request: Record<string, unknown> } };
    const fixture: OperationFixture = {
      ...recorded,
      name: 'one-turn',
      settings: { keyId: 'AKID-7' },
      session: {
        ...recorded.session,
        request: { ...recorded.session.request, headers: { 'x-key-id': 'AKID-7' } },
      },
    };
    expect(contractFailures(await operationContract(descriptor, [fixture]))).toEqual([]);
    const without = Object.fromEntries(
      Object.entries(fixture).filter(([k]) => k !== 'settings'),
    ) as unknown as OperationFixture;
    expect(contractFailures(await operationContract(descriptor, [without])).length).toBeGreaterThan(
      0,
    );
  });

  it('operation@1 proves a descriptor that reads settings and a named key, with the settings its fixture records', async () => {
    const bytes = signer([{ hmac: { key: 'connection.signing', of: [{ input: 'body' }] } }]);
    const descriptor = parseDescriptor(
      yamlOf(bytes, { ...withSetting, keys: '[connection, connection.signing]' }),
    );
    const fixture: OperationFixture = {
      name: 'signed-order',
      deployment: 'model-1',
      at: at.toISOString(),
      settings,
      input: { item: 'pen' },
      request: {
        method: 'POST',
        path: '/orders',
        query: { region: 'eu-north-1' },
        headers: { 'x-key-id': 'AKID-7' },
        body: { item: 'pen' },
      },
      response: { body: { status: 'placed' } },
      result: { status: 'placed' },
      usage: { requests: 1 },
    };
    const results = await operationContract(descriptor, [fixture], { modules: () => bytes });
    expect(contractFailures(results)).toEqual([]);
    const without = Object.fromEntries(
      Object.entries(fixture).filter(([k]) => k !== 'settings'),
    ) as unknown as OperationFixture;
    expect(
      contractFailures(await operationContract(descriptor, [without], { modules: () => bytes }))
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('a signing module on a step sent in parts or retried (D)', () => {
  const inParts = {
    keys: '[connection, connection.signing]',
    input: '{ object: { file: { media: image/png } } }',
    step: 'parts: { of: $input.file, bytes: 32, most: 4 }',
    request: '{ method: PUT, path: /objects, encoding: binary, body: $part.body }',
    wire: '      request: { media: image/png }\n      response: { object: { status: plain } }',
  };
  const file = Buffer.from(png, 'base64');
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const partSha = (n: number) => sha(file.subarray(n * 32, (n + 1) * 32));
  const named = { endpoint: { keys: { signing: async () => 'extra-signing-key' } } };

  it("a step sent in parts signs every part over the SHA-256 of that part's bytes, with the module's header on each", async () => {
    const bytes = signer([
      { input: 'body_sha256' },
      { text: ':' },
      { hmac: { key: 'connection.signing', of: [{ input: 'body_sha256' }] } },
    ]);
    const placed = json({ status: 'placed' });
    const { outcome, sent, exchanges } = await run(bytes, inParts, { file: png }, named, [
      placed,
      placed,
      placed,
    ]);
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(sent).toHaveLength(3);
    expect(sent.map((_, n) => headersOf(sent, n).get('x-signature'))).toEqual(
      [0, 1, 2].map((n) => `${partSha(n)}:${hex('extra-signing-key', partSha(n))}`),
    );
    expect(sent.map((_, n) => headersOf(sent, n).get('x-api-version'))).toEqual(['7', '7', '7']);
    expect(leaks(sent, exchanges, ['extra-signing-key', 'connection-key'])).toEqual([]);
  });

  it("a part the provider refuses keeps its body on the failure with the named key and the part's signature redacted", async () => {
    const bytes = signer([{ hmac: { key: 'connection.signing', of: [{ input: 'body_sha256' }] } }]);
    const signature = hex('extra-signing-key', partSha(1));
    const { outcome, sent, exchanges } = await run(bytes, inParts, { file: png }, named, [
      json({ status: 'placed' }),
      json({ error: { message: `bad signature ${signature} for key extra-signing-key` } }, 403),
    ]);
    expect(sent).toHaveLength(2);
    expect(headersOf(sent, 1).get('x-signature')).toBe(signature);
    const error = errorOf(outcome) as Error & { provider?: { status: number; body?: string } };
    expect(error.provider).toEqual({
      status: 403,
      body: expect.stringContaining('bad signature [redacted] for key [redacted]'),
    });
    expect(leaks(sent, exchanges, ['extra-signing-key', 'connection-key'])).toEqual([]);
    expect(`${error.message}${error.provider?.body ?? ''}`).not.toContain(signature);
  });

  it("a retried request is signed anew on every attempt, so a module that reads the timestamp signs each attempt's time", async () => {
    let ticks = 0;
    const now = () => new Date(at.getTime() + 1000 * ticks++);
    const stamp = (n: number) => String(Math.floor(at.getTime() / 1000) + n);
    const bytes = signer([
      { input: 'timestamp' },
      { text: ':' },
      { hmac: { key: 'connection', of: [{ input: 'timestamp' }, { input: 'body' }] } },
    ]);
    const { outcome, sent, slept } = await run(
      bytes,
      {
        response:
          '    usage: { request: 1 }\n    errors: [{ status: 503, kind: unavailable, retry: true }]',
      },
      undefined,
      { endpoint: { now } },
      [
        json({ error: { message: 'busy' } }, 503, { 'retry-after': '1' }),
        json({ status: 'placed' }),
      ],
    );
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(slept).toEqual([1000]);
    const body = String(sent[0]?.init?.body);
    expect(sent.map((_, n) => headersOf(sent, n).get('x-signature'))).toEqual(
      [0, 1].map((n) => `${stamp(n)}:${hex('connection-key', stamp(n) + body)}`),
    );
  });
});
