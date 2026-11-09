import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractFailures, operationContract, type OperationFixture } from './contract.js';
import { parseDescriptor } from './descriptor.js';
import { call, json, refused } from './kit.test-utils.js';
import { moduleProblems, sha256Of } from './module.js';
import { emitting, hmacSigner, op, wasmModule } from './wasm.test-utils.js';

const errorOf = (outcome: unknown) => (outcome as { error: Error }).error;
const at = new Date('2026-11-06T10:00:00Z');
const stamp = String(Math.floor(at.getTime() / 1000));

const yamlFor = (
  bytes: Uint8Array,
  emits = "sig: { ref: '^[0-9a-f]{64}$' }\n        ts: { ref: '^[0-9]{10}$' }",
) => `
id: example/signed-order@1
operation: signed-order
status: described
summary: A made-up API that wants every request signed with HMAC-SHA256 over the body and a timestamp.
api: { family: example, version: '1' }
modules:
  signer:
    sha256: ${sha256Of(bytes)}
    keys: [connection]
input: { object: { item: text } }
output: { object: { status: plain } }
result: { status: $response.status }
steps:
  - name: place
    request: { method: POST, path: /orders, body: { item: $input.item } }
    module:
      use: signer
      emits:
        ${emits}
      headers: { x-signature: sig, x-timestamp: ts }
    wire:
      request: { object: { item: text } }
      response: { object: { status: plain } }
    usage: { request: 1 }
`;

const place = async (bytes: Uint8Array, stored: Uint8Array = bytes, yaml = yamlFor(bytes)) =>
  call(parseDescriptor(yaml), { item: 'pen' }, [json({ status: 'placed' })], {
    endpoint: { modules: () => stored, now: () => at },
  });

describe('a module that signs a request (D)', () => {
  it('the checked-in test module is the one the builder makes', () => {
    const file = join(import.meta.dirname, 'testdata', 'modules', 'hmac-signer.wasm');
    expect(new Uint8Array(readFileSync(file))).toEqual(hmacSigner());
  });

  it('signs the body and a timestamp the host gives with the connection key, which never enters the module', async () => {
    const { outcome, sent } = await place(hmacSigner());
    expect(outcome).toEqual({ result: { status: 'placed' } });
    const body = String(sent[0]?.init?.body);
    const expected = createHmac('sha256', 'connection-key')
      .update(body + stamp)
      .digest('hex');
    expect(sent[0]?.init?.headers).toMatchObject({ 'x-signature': expected, 'x-timestamp': stamp });
  });

  it('a module with the wrong bytes for its pinned SHA-256 is refused before it runs', async () => {
    const { outcome, sent } = await place(hmacSigner(), emitting('sig', 'x'));
    expect(errorOf(outcome).message).toMatch(/does not match its pinned SHA-256/);
    expect(sent).toEqual([]);
  });

  it('a module that is not stored is refused', async () => {
    const descriptor = parseDescriptor(yamlFor(hmacSigner()));
    const { outcome } = await call(descriptor, { item: 'pen' }, [json({})], {});
    expect(errorOf(outcome).message).toMatch(/the module signer is not stored/);
  });
});

const pathEcho = () =>
  wasmModule({
    imports: ['input_read', 'emit'],
    locals: 1,
    data: [{ at: 0, text: 'path' }],
    body: [
      ...op.i32(0),
      ...op.i32(4),
      ...op.i32(1024),
      ...op.i32(512),
      ...op.call(0),
      ...op.set(0),
      ...op.i32(0),
      ...op.i32(4),
      ...op.i32(1024),
      ...op.get(0),
      ...op.call(1),
      ...op.drop,
    ],
  });

const signedOnly = (bytes: Uint8Array, emits?: string) =>
  yamlFor(bytes, emits).replace(
    "api: { family: example, version: '1' }",
    "api: { family: example, version: '1' }\nauth: { signedBy: module }",
  );

describe('a key that only signs (D)', () => {
  it('is handed to the module and never sent in a header or the query', async () => {
    const bytes = hmacSigner();
    const { outcome, sent } = await place(bytes, bytes, signedOnly(bytes));
    expect(outcome).toEqual({ result: { status: 'placed' } });
    const headers = Object.values(sent[0]?.init?.headers as Record<string, string>);
    expect(headers.some((v) => v.includes('connection-key'))).toBe(false);
    expect(String(sent[0]?.url)).not.toContain('connection-key');
    const expected = createHmac('sha256', 'connection-key')
      .update(String(sent[0]?.init?.body) + stamp)
      .digest('hex');
    expect(sent[0]?.init?.headers).toMatchObject({ 'x-signature': expected });
  });

  it('needs a module that takes the connection key on every step', () => {
    const yaml = signedOnly(hmacSigner()).replace('    keys: [connection]\n', '');
    expect(() => parseDescriptor(yaml)).toThrow(/a key that only signs needs a module/);
  });

  it('a module signs the path as sent, with the base path and the query', async () => {
    const bytes = pathEcho();
    const yaml = signedOnly(bytes, "path: { ref: '^/[a-z/]+[?]since=5$' }")
      .replace('{ x-signature: sig, x-timestamp: ts }', '{ x-signed-path: path }')
      .replace('path: /orders,', 'path: /orders, query: { since: "5" },')
      .replace(
        '      request: { object: { item: text } }',
        '      query: { object: { since: { enum: ["5"] } } }\n      request: { object: { item: text } }',
      );
    const { outcome, sent } = await place(bytes, bytes, yaml);
    expect(outcome).toEqual({ result: { status: 'placed' } });
    expect(sent[0]?.init?.headers).toMatchObject({ 'x-signed-path': '/base/orders?since=5' });
  });

  it('a step may not place a key that only signs', () => {
    const yaml = signedOnly(hmacSigner()).replace(
      '  - name: place\n',
      '  - name: place\n    credential: { header: x-key }\n',
    );
    expect(() => parseDescriptor(yaml)).toThrow(/a key that only signs is placed on no request/);
  });

  it('stays off an exchanged token step and a followed link, which need no module', async () => {
    const bytes = hmacSigner();
    const yaml = `
id: example/signed-export@1
operation: signed-export
status: described
summary: A made-up API that signs a token request and an export, then serves the file at a link.
api: { family: example, version: '1' }
auth: { signedBy: module }
modules:
  signer:
    sha256: ${sha256Of(bytes)}
    keys: [connection]
input: { object: { item: text } }
output: { object: { data: { media: [text/csv] } } }
steps:
  - name: token
    request: { method: POST, path: /token, body: { item: $input.item } }
    module:
      use: signer
      emits: { sig: { ref: '^[0-9a-f]{64}$' }, ts: { ref: '^[0-9]{10}$' } }
      headers: { x-signature: sig, x-timestamp: ts }
    wire:
      request: { object: { item: text } }
      response: { object: { token: opaque } }
    bind:
      access: { from: $response.token, class: secret }
  - name: start
    auth: { header: authorization, scheme: Bearer, secret: $steps.token.access }
    request: { method: POST, path: /exports, body: { item: $input.item } }
    wire:
      request: { object: { item: text } }
      response: { object: { location: plain } }
    bind:
      link: { from: $response.location, class: url }
  - name: fetch
    request: { method: GET, follow: $steps.start.link }
    response: { encoding: binary }
    wire:
      response: { media: [text/csv] }
result:
  data: $response
`;
    const { outcome, sent, exchanges } = await call(
      parseDescriptor(yaml),
      { item: 'pen' },
      [
        json({ token: 'tok-very-secret' }),
        json({ location: 'https://provider.example.test/files/e1.csv' }),
        { type: 'text/csv', body: 'a,b\n' },
      ],
      { endpoint: { modules: () => bytes, now: () => at } },
    );
    expect('result' in outcome).toBe(true);
    expect(sent).toHaveLength(3);
    for (const request of sent) {
      expect(JSON.stringify(request.init?.headers)).not.toContain('connection-key');
      expect(request.url.href).not.toContain('connection-key');
      expect(String(request.init?.body ?? '')).not.toContain('connection-key');
    }
    expect(new Headers(sent[1]?.init?.headers).get('authorization')).toBe('Bearer tok-very-secret');
    expect(new Headers(sent[2]?.init?.headers).get('authorization')).toBeNull();
    expect(JSON.stringify(exchanges)).not.toContain('connection-key');
  });

  it('passes operation@1 only when the key reaches no request', async () => {
    const bytes = hmacSigner();
    const fixture: OperationFixture = {
      name: 'one-order',
      deployment: 'model-1',
      at: at.toISOString(),
      input: { item: 'pen' },
      request: { method: 'POST', path: '/orders', body: { item: 'pen' } },
      response: { body: { status: 'placed' } },
      result: { status: 'placed' },
      usage: { requests: 1 },
    };
    const results = await operationContract(parseDescriptor(signedOnly(bytes)), [fixture], {
      modules: () => bytes,
    });
    expect(contractFailures(results)).toEqual([]);
  });
});

describe('hostile modules (D)', () => {
  const sig = '0123456789abcdef'.repeat(4);

  it('a module that runs past the time limit is stopped and refused', async () => {
    const hang = wasmModule({ body: op.loopForever });
    const { outcome, sent } = await place(hang);
    expect(errorOf(outcome).message).toMatch(/ran over 250 ms/);
    expect(sent).toEqual([]);
  });

  it('a module that asks for more memory than the host allows cannot be linked', async () => {
    const greedy = wasmModule({ memory: { min: 200 }, body: [] });
    const { outcome } = await place(greedy);
    expect(errorOf(outcome).message).toMatch(/the module failed/);
  });

  it('a module that defines its own memory is refused when it is stored, because the host cannot limit it', () => {
    expect(moduleProblems(wasmModule({ memory: 'own', body: [] }))).toContain(
      'the module defines its own memory; it imports the memory the host gives it',
    );
  });

  it('a module that imports anything but the host functions is refused, so it has no network, file or clock', () => {
    const problems = moduleProblems(
      wasmModule({
        foreign: [
          { module: 'wasi_snapshot_preview1', name: 'fd_write' },
          { module: 'env', name: 'now' },
          { module: 'genki', name: 'read_key' },
        ],
        body: [],
      }),
    );
    expect(problems).toEqual([
      'the module imports wasi_snapshot_preview1.fd_write, which the host does not offer',
      'the module imports env.now, which the host does not offer',
      'the module imports genki.read_key, which the host does not offer',
    ]);
  });

  it('a module with no run function is refused', () => {
    expect(moduleProblems(wasmModule({ noRun: true, body: [] }))).toContain(
      'the module exports no run function',
    );
  });

  it('a file that is not WebAssembly is refused, and so is a module over the size cap', () => {
    expect(moduleProblems(new TextEncoder().encode('not a module at all'))).toEqual([
      'the module is not a WebAssembly binary',
    ]);
    expect(moduleProblems(new Uint8Array(200 * 1024))).toEqual(['a module is at most 128 KiB']);
  });

  it('a module cannot read a key the descriptor did not hand it', async () => {
    const reader = wasmModule({
      imports: ['input_read', 'emit'],
      locals: 1,
      data: [{ at: 0, text: 'connectionsig' }],
      body: [
        ...op.i32(0),
        ...op.i32(10),
        ...op.i32(1024),
        ...op.i32(64),
        ...op.call(0),
        ...op.set(0),
        ...op.i32(10),
        ...op.i32(3),
        ...op.i32(1024),
        ...op.get(0),
        ...op.call(1),
        ...op.drop,
      ],
    });
    const { outcome, sent } = await place(reader);
    expect(errorOf(outcome).message).toMatch(/reached outside its memory/);
    expect(sent).toEqual([]);
  });

  it('a module that returns a value its descriptor did not declare is refused', async () => {
    const { outcome, sent } = await place(emitting('leak', sig));
    expect(errorOf(outcome).message).toMatch(/outside its wire shape/);
    expect(sent).toEqual([]);
  });

  it('a module that returns a value outside the pattern its descriptor pins is refused', async () => {
    const { outcome, sent } = await place(emitting('sig', 'Mr Hansen, 01019012345'));
    expect(errorOf(outcome).message).toMatch(/outside its wire shape/);
    expect(sent).toEqual([]);
  });

  it('a module that returns a value over the length cap fails', async () => {
    const { outcome } = await place(emitting('sig', 'a'.repeat(600)));
    expect(errorOf(outcome).message).toMatch(/too long/);
  });

  it('a module that reaches outside its memory traps and the call fails', async () => {
    const wild = wasmModule({
      imports: ['emit'],
      body: [
        ...op.i32(0),
        ...op.i32(3),
        ...op.i32(900_000),
        ...op.i32(8),
        ...op.call(0),
        ...op.drop,
      ],
    });
    const { outcome } = await place(wild);
    expect(errorOf(outcome).message).toMatch(/reached outside its memory/);
  });
});

describe('descriptors that name a module (D)', () => {
  const bytes = hmacSigner();
  const base = yamlFor(bytes);

  it('a step uses only a module the descriptor declares', () => {
    expect(refused(base.replace('use: signer', 'use: other'))).toMatch(
      /module.use other is not declared under modules/,
    );
  });

  it('a module returns a value pinned by an anchored ref pattern or an enum, never free text', () => {
    expect(refused(yamlFor(bytes, 'sig: text\n        ts: { ref: "^[0-9]{10}$" }'))).toMatch(
      /never free text/,
    );
    expect(
      refused(yamlFor(bytes, "sig: { ref: '[0-9a-f]+' }\n        ts: { ref: '^1$' }")),
    ).toMatch(/never free text/);
  });

  it('a module cannot set a credential header', () => {
    expect(refused(base.replace('x-signature: sig', 'authorization: sig'))).toMatch(
      /credentials come from the endpoint/,
    );
  });

  it('every value a module returns goes to a header, and every header names a declared value', () => {
    expect(refused(base.replace('x-timestamp: ts', 'x-timestamp: nope'))).toMatch(
      /names nope, which emits does not declare/,
    );
    expect(refused(base.replace(', x-timestamp: ts', ''))).toMatch(/ts is mapped to no header/);
  });

  it('a module key is one the host knows', () => {
    expect(refused(base.replace('keys: [connection]', 'keys: [admin]'))).toMatch(/keys/);
  });

  it('a module pin is a SHA-256 in hex', () => {
    expect(refused(base.replace(sha256Of(bytes), 'abc'))).toMatch(/sha256/);
  });

  it('a descriptor names at most two modules', () => {
    const three = base.replace(
      'modules:\n',
      `modules:\n  a: { sha256: ${'a'.repeat(64)} }\n  b: { sha256: ${'b'.repeat(64)} }\n`,
    );
    expect(refused(three)).toMatch(/at most 2 modules/);
  });

  it('a module signs a plain request, so a stream step may not use one', () => {
    expect(
      refused(
        base.replace(
          '    wire:\n      request:',
          '    response: { stream: { framing: sse, name: event, events: {} } }\n    wire:\n      request:',
        ),
      ),
    ).toBeDefined();
  });
});
