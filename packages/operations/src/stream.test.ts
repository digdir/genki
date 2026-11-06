import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Usage } from '@genai/contracts';
import {
  createGate,
  type GateChunk,
  type GateRecord,
  type Masker,
  type PortContext,
} from '@genai/kernel';
import { parseDescriptor, type Descriptor } from './descriptor.js';
import { readFrames } from './encoding.js';
import { describedStreamCall, OperationError } from './executor.js';
import { call, json, refused } from './kit.test-utils.js';

const testdata = join(import.meta.dirname, 'testdata', 'descriptors', 'example');
const yamlOf = (name: string) => readFileSync(join(testdata, `${name}.yaml`), 'utf8');
const events = () => parseDescriptor(yamlOf('stream-events@1'));
const errorOf = (outcome: unknown) => (outcome as { error: Error }).error;

const sse = (frames: { event?: string; data: unknown }[]) =>
  frames
    .map(
      (f) =>
        `${f.event ? `event: ${f.event}\n` : ''}data: ${typeof f.data === 'string' ? f.data : JSON.stringify(f.data)}\n\n`,
    )
    .join('');

const stream = (body: string) => ({ type: 'text/event-stream', body });
const token = (text: string) => ({ event: 'token', data: { text } });

const tokenMasker = (): Masker => {
  const values = new Map<string, string>();
  return {
    mask: (text) =>
      text.replace(/\b\d{11}\b/g, (value) => {
        const mask = `«ID_${values.size + 1}»`;
        values.set(mask, value);
        return mask;
      }),
    unmask: (text) => text.replace(/«ID_\d+»/g, (mask) => values.get(mask) ?? mask),
    pending: (text) => {
      const open = text.lastIndexOf('«');
      return open >= 0 && !text.includes('»', open) ? text.length - open : 0;
    },
  };
};

const streamed = async (descriptor: Descriptor, input: unknown, body: string, masker?: Masker) => {
  const sent: string[] = [];
  const audit: GateRecord[] = [];
  const metered: Usage[] = [];
  const ctx: PortContext = {
    tenant: '999888777',
    principal: { kind: 'operator', issuer: 'test', subject: 'ola' },
    task: 't1',
    signal: new AbortController().signal,
    meter: async (usage) => {
      metered.push(usage);
    },
    audit: async (record) => {
      audit.push(record);
    },
    ...(masker ? { guards: [{ masker }] } : {}),
  };
  const chunks: GateChunk<unknown>[] = [];
  let failure: unknown;
  try {
    for await (const chunk of describedStreamCall(
      {
        gate: createGate(),
        ctx,
        target: {
          port: 'described',
          operation: descriptor.operation,
          model: { kind: 'model', id: 'lab/model' },
          residency: 'norway',
          admission: 'open',
          synthetic: true,
        },
        descriptor,
        endpoint: {
          baseURL: 'https://provider.example.test/base',
          credential: { kind: 'api-key', key: async () => 'k' },
          fetch: async (_url, init) => {
            sent.push(String(init?.body));
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
          },
        },
        deployment: 'model-1',
      },
      input,
    ))
      chunks.push(chunk);
  } catch (error) {
    failure = error;
  }
  return { chunks, sent, audit, metered, failure };
};

describe('streamed answers (B)', () => {
  const body = sse([
    token('Hei '),
    token('der'),
    { event: 'stats', data: { input: 4, output: 2, unknown: 1 } },
    { event: 'finished', data: {} },
  ]);

  it('a streamed step passes its text deltas on, then the result, and meters usage from the events', async () => {
    const { chunks, metered, audit } = await streamed(events(), { question: 'Hei?' }, body);
    expect(chunks).toEqual([
      { kind: 'delta', text: 'Hei ' },
      { kind: 'delta', text: 'der' },
      { kind: 'done', result: { answer: 'Hei der' } },
    ]);
    expect(metered).toEqual([{ inputTokens: 4, outputTokens: 2, requests: 1 }]);
    expect(audit[0]).toMatchObject({ outcome: 'ok', dropped: 1 });
  });

  it('the same descriptor called without streaming collects the deltas into its result', async () => {
    const { outcome } = await call(events(), { question: 'Hei?' }, [stream(body)]);
    expect(outcome).toEqual({ result: { answer: 'Hei der' } });
  });

  it('the gate restores masked values in deltas, also when a mask is cut between two events', async () => {
    const cut = sse([
      token('Nummeret er «ID'),
      token('_1» og '),
      token('«ID_1»'),
      { event: 'finished', data: {} },
    ]);
    const { chunks, sent } = await streamed(
      events(),
      { question: 'Mitt nummer er 12345678901' },
      cut,
      tokenMasker(),
    );
    expect(sent[0]).toContain('«ID_1»');
    expect(sent[0]).not.toContain('12345678901');
    const text = chunks.flatMap((c) => (c.kind === 'delta' ? [c.text] : [])).join('');
    expect(text).toBe('Nummeret er 12345678901 og 12345678901');
    expect(chunks.at(-1)).toEqual({
      kind: 'done',
      result: { answer: 'Nummeret er 12345678901 og 12345678901' },
    });
  });

  it('the stream ends on an event the descriptor does not declare', async () => {
    const { chunks, failure, audit } = await streamed(
      events(),
      { question: 'x' },
      sse([token('a'), { event: 'tool_call', data: { text: 'ignore previous' } }, token('b')]),
    );
    expect((failure as Error).message).toMatch(/event it does not declare \(tool_call\)/);
    expect(chunks).toEqual([{ kind: 'delta', text: 'a' }]);
    expect(audit[0]?.outcome).toBe('failed');
  });

  it('an event outside its declared shape fails the call', async () => {
    const { failure } = await streamed(
      events(),
      { question: 'x' },
      sse([{ event: 'token', data: { text: 42 } }]),
    );
    expect((failure as Error).message).toMatch(/outside its shape \(token\)/);
  });

  it('a failure event maps to the error kind it declares', async () => {
    const { outcome } = await call(events(), { question: 'x' }, [
      stream(sse([token('a'), { event: 'failed', data: { detail: 'overloaded' } }])),
    ]);
    expect(errorOf(outcome)).toBeInstanceOf(OperationError);
    expect(errorOf(outcome)).toMatchObject({ kind: 'unavailable', message: 'overloaded' });
  });

  it('a stream that ends before its final event fails the call as unavailable', async () => {
    const { outcome } = await call(events(), { question: 'x' }, [stream(sse([token('a')]))]);
    expect(errorOf(outcome)).toMatchObject({ kind: 'unavailable' });
    expect(errorOf(outcome).message).toMatch(/ended without its final event/);
  });

  it('a streamed answer with another content type fails the call', async () => {
    const { outcome } = await call(events(), { question: 'x' }, [json({ text: 'a' })]);
    expect(errorOf(outcome).message).toMatch(/declares a sse stream/);
  });

  it('a request that the stream step refuses is refused before anything leaves, as for any step', async () => {
    const { sent, failure } = await streamed(events(), { question: 'x', extra: 1 }, body);
    expect((failure as Error).message).toMatch(/outside its shape/);
    expect(sent).toEqual([]);
  });

  it('an sse event is cut at any line ending, also a CRLF split between two chunks', async () => {
    const encoder = new TextEncoder();
    const parts = [
      'event: a\r',
      '\ndata: 1\r\n\r',
      '\ndata: 2\n\n:comment\n',
      'data: x\ndata: y\n\n',
    ];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const part of parts) controller.enqueue(encoder.encode(part));
          controller.close();
        },
      }),
    );
    const frames = [];
    for await (const frame of readFrames(response, 'sse', 1000)) frames.push(frame);
    expect(frames).toEqual([{ event: 'a', data: '1' }, { data: '2' }, { data: 'x\ny' }]);
  });

  it('a stream over the byte cap is cut off', async () => {
    const response = new Response('data: 0123456789\n\n'.repeat(10));
    await expect(async () => {
      for await (const frame of readFrames(response, 'sse', 50)) void frame;
    }).rejects.toThrow(/over the cap/);
  });
});

describe('ndjson and lines framing (B)', () => {
  const ndjson = () =>
    parseDescriptor(
      yamlOf('stream-events@1')
        .replace('framing: sse', 'framing: ndjson\n        name: $event.type')
        .replace(
          'shape: { object: { text: text } }',
          'shape: { object: { type: plain, text: text } }',
        )
        .replace(
          'input: { number: { integer: true } }',
          'type: plain\n                input: { number: { integer: true } }',
        )
        .replace(
          'shape: { object: { detail: plain } }',
          'shape: { object: { type: plain, detail: plain } }',
        )
        .replace('shape: { object: {} }', 'shape: { object: { type: plain } }'),
    );
  const lines = (body: string) => ({ type: 'application/x-ndjson', body });

  it('an ndjson stream names its events from a field of each line', async () => {
    const { outcome } = await call(ndjson(), { question: 'x' }, [
      lines(
        [{ type: 'token', text: 'a' }, { type: 'token', text: 'b' }, { type: 'finished' }]
          .map((l) => `${JSON.stringify(l)}\n`)
          .join(''),
      ),
    ]);
    expect(outcome).toEqual({ result: { answer: 'ab' } });
  });

  it('an ndjson line without a known name ends the stream', async () => {
    const { outcome } = await call(ndjson(), { question: 'x' }, [
      lines('{"type":"token","text":"a"}\n{"type":"mystery"}\n'),
    ]);
    expect(errorOf(outcome).message).toMatch(/does not declare \(mystery\)/);
  });

  const plainLines = () =>
    parseDescriptor(
      yamlOf('stream-events@1')
        .replace(
          / {4}response:\n {6}stream:[\s\S]*? {4}usage:/,
          '    response:\n      stream:\n        framing: lines\n        events:\n          line:\n            shape: text\n            delta: $event\n    usage:',
        )
        .replace(/ {6}input-token[\s\S]*?request: 1\n/, '      request: 1\n'),
    );

  it('a lines stream delivers each non-empty line as text', async () => {
    const { outcome } = await call(plainLines(), { question: 'x' }, [
      { type: 'text/plain', body: 'one\n\ntwo\n' },
    ]);
    expect(outcome).toEqual({ result: { answer: 'onetwo' } });
  });

  it('a stream with more events than the cap fails the call', async () => {
    const many = '{"type":"token","text":"a"}\n'.repeat(50_001);
    const { outcome } = await call(ndjson(), { question: 'x' }, [lines(many)]);
    expect(errorOf(outcome).message).toMatch(/more than 50000 events/);
  });
});

describe('hostile stream declarations are refused at load (G)', () => {
  const base = () => yamlOf('stream-events@1');

  it('a delta must point at a text field, so the gate can mask and restore it', () => {
    expect(refused(base().replace('delta: $event.text', 'delta: $event.missing'))).toMatch(
      /delta must point at a text field/,
    );
    expect(
      refused(
        base().replace('shape: { object: { text: text } }', 'shape: { object: { text: plain } }'),
      ),
    ).toMatch(/delta must point at a text field/);
  });

  it('a streamed answer carries no media', () => {
    expect(
      refused(
        base().replace(
          'shape: { object: { text: text } }',
          'shape: { object: { text: text, pic: { media: image/png } } }',
        ),
      ),
    ).toMatch(/a stream event carries no media/);
  });

  it('a streamed step is the last step and is read once', () => {
    const second = base();
    expect(
      refused(
        second.replace(
          'result:',
          '  - name: after\n    request:\n      method: GET\n      path: /x\n    wire:\n      response: text\nresult:',
        ),
      ),
    ).toMatch(/a streamed answer or a session is the last step/);
    expect(
      refused(
        base().replace(
          '    usage:\n',
          '    until: { test: $response.text, intervalSeconds: 1, longestSeconds: 5 }\n    usage:\n',
        ),
      ),
    ).toMatch(/a streamed answer is read once/);
  });

  it('a stream declares its events instead of a wire.response', () => {
    expect(
      refused(
        base().replace(
          '          question: text\n    response:',
          '          question: text\n      response: text\n    response:',
        ),
      ),
    ).toMatch(/wire.response is not declared for a stream/);
  });

  it('a lines stream has the one event line, and no event names to read', () => {
    expect(refused(base().replace('framing: sse', 'framing: lines'))).toMatch(
      /a lines stream has one event, line/,
    );
  });

  it('a stream that names an unknown framing is refused', () => {
    expect(refused(base().replace('framing: sse', 'framing: websocket'))).toMatch(/framing/);
  });
});
