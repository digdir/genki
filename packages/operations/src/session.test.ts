import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Usage } from '@genai/contracts';
import {
  createGate,
  type GateRecord,
  type Masker,
  type Maturity,
  type PayloadGuard,
  type PortContext,
} from '@genai/kernel';
import { parseDescriptor, type Descriptor } from './descriptor.js';
import { describedSession, type SessionIO, type SessionOutcome } from './session.js';
import { acceptWebSocket, type WsMessage, type WsPeer } from './websocket.js';

const here = import.meta.dirname;
const chat = () =>
  parseDescriptor(
    readFileSync(join(here, 'testdata/descriptors/example/chat-session@1.yaml'), 'utf8'),
  );
const realtime = () =>
  parseDescriptor(
    readFileSync(join(here, '../descriptors/openai/realtime-transcription@1.yaml'), 'utf8'),
  );

const servers: Server[] = [];
const sockets: Duplex[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

interface Provider {
  url: string;
  requests: IncomingMessage[];
  received: WsMessage[];
}

const provider = async (behave: (peer: WsPeer, provider: Provider) => void): Promise<Provider> => {
  const server = createServer();
  const state: Provider = { url: '', requests: [], received: [] };
  server.on('upgrade', (req, socket, head) => {
    state.requests.push(req);
    sockets.push(socket);
    const peer = acceptWebSocket(req, socket, head);
    if (!peer) return;
    void (async () => {
      for await (const message of peer.messages()) state.received.push(message);
    })();
    behave(peer, state);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return state;
};

const text = (value: unknown): WsMessage => ({ kind: 'text', text: JSON.stringify(value) });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const channel = () => {
  const items: WsMessage[] = [];
  const sent: WsMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const io: SessionIO = {
    incoming: {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          while (items.length === 0 && !closed) await new Promise<void>((r) => (wake = r));
          return items.length > 0
            ? { value: items.shift() as WsMessage, done: false }
            : { value: undefined, done: true };
        },
      }),
    },
    send: (m) => void sent.push(m),
  };
  return {
    io,
    sent,
    push: (m: WsMessage) => {
      items.push(m);
      wake?.();
    },
    close: () => {
      closed = true;
      wake?.();
    },
  };
};

const tokenMasker = (): Masker => {
  const values = new Map<string, string>();
  return {
    mask: (t) =>
      t.replace(/\b\d{11}\b/g, (v) => {
        const mask = `«ID_${values.size + 1}»`;
        values.set(mask, v);
        return mask;
      }),
    unmask: (t) => t.replace(/«ID_\d+»/g, (m) => values.get(m) ?? m),
    pending: (t) => {
      const open = t.lastIndexOf('«');
      return open >= 0 && !t.includes('»', open) ? t.length - open : 0;
    },
  };
};

const wavFrame = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

const run = async (
  descriptor: Descriptor,
  where: Provider,
  input: unknown,
  drive: (c: ReturnType<typeof channel>) => Promise<void> | void,
  options: {
    synthetic?: boolean;
    unmaskedMedia?: string[];
    guards?: PayloadGuard[];
    maturity?: () => Promise<Maturity>;
    abort?: AbortController;
    baseURL?: string;
  } = {},
) => {
  const audit: GateRecord[] = [];
  const metered: Usage[] = [];
  const ctx: PortContext = {
    tenant: '999888777',
    principal: { kind: 'operator', issuer: 'test', subject: 'ola' },
    task: 't1',
    signal: (options.abort ?? new AbortController()).signal,
    meter: async (u) => void metered.push(u),
    audit: async (r) => void audit.push(r),
    ...(options.unmaskedMedia ? { unmaskedMedia: options.unmaskedMedia } : {}),
    ...(options.guards ? { guards: options.guards } : {}),
  };
  const c = channel();
  const outcome = await Promise.all([
    describedSession(
      {
        gate: createGate({
          tier: 'production',
          media: {
            allows: () => true,
            maxBytes: () => 1_000_000,
            keep: async (k) => ({ tenant: k.tenant, path: 'kept/1', sha256: 'abc' }),
          },
        }),
        ctx,
        target: {
          port: 'described',
          operation: descriptor.operation,
          model: { kind: 'model', id: 'lab/model' },
          endpoint: 'lab',
          residency: 'norway',
          admission: 'open',
          ...(options.synthetic === false ? {} : { synthetic: true }),
        },
        descriptor,
        endpoint: {
          baseURL: options.baseURL ?? where.url,
          credential: { kind: 'api-key', key: async () => 'connection-key' },
        },
        deployment: 'model-1',
        ...(options.maturity ? { maturity: options.maturity, maturityEveryMs: 20 } : {}),
      },
      input,
      c.io,
    ).then(
      (result): { result: SessionOutcome } => ({ result }),
      (error: unknown) => ({ error: error as Error }),
    ),
    (async () => {
      await settle(80);
      await drive(c);
    })(),
  ]).then(([o]) => o);
  c.close();
  return { outcome, audit, metered, client: c.sent };
};

describe('a live session through the gate (E)', () => {
  it('relays text both ways, builds the transcript from the declared field and ends on its done event', async () => {
    const where = await provider((peer) => {
      void (async () => {
        await settle(150);
        peer.send(text({ event: 'reply', text: 'Hel' }));
        peer.send(text({ event: 'reply', text: 'lo' }));
        peer.send(text({ event: 'stats', input: 5, output: 2 }));
        peer.send(text({ event: 'bye' }));
      })();
    });
    const { outcome, metered, audit, client } = await run(
      chat(),
      where,
      { topic: 'greeting' },
      (c) => c.push(text({ event: 'say', text: 'hi' })),
    );
    expect(outcome).toMatchObject({ result: { end: 'done', transcript: 'Hello' } });
    expect(where.received.map((m) => (m.kind === 'text' ? JSON.parse(m.text) : m))).toEqual([
      { event: 'say', text: 'hi' },
    ]);
    expect(client).toHaveLength(4);
    expect(metered).toEqual([{ inputTokens: 5, outputTokens: 2, requests: 1 }]);
    expect(audit).toEqual([
      expect.objectContaining({
        outcome: 'ok',
        descriptor: 'example/chat-session@1',
        usage: { inputTokens: 5, outputTokens: 2, requests: 1 },
      }),
    ]);
    const headers = where.requests[0]?.headers;
    expect(headers?.authorization).toBe('Bearer connection-key');
    expect(where.requests[0]?.url).toBe('/v1/live');
  });

  it('masks personal data going out and restores it coming back, also when a token is cut across two messages', async () => {
    const where = await provider((peer, p) => {
      void (async () => {
        while (p.received.length === 0) await settle(10);
        const sent = JSON.parse((p.received[0] as { text: string }).text) as { text: string };
        const mask = /«ID_\d+»/.exec(sent.text)?.[0] ?? '';
        peer.send(text({ event: 'reply', text: `Id ${mask.slice(0, 3)}` }));
        peer.send(text({ event: 'reply', text: `${mask.slice(3)} ok` }));
        peer.send(text({ event: 'bye' }));
      })();
    });
    const { outcome, client } = await run(
      chat(),
      where,
      { topic: 'x' },
      (c) => c.push(text({ event: 'say', text: 'mitt nummer er 01019012345' })),
      { guards: [{ masker: tokenMasker() }] },
    );
    const sentToProvider = JSON.parse((where.received[0] as { text: string }).text) as {
      text: string;
    };
    expect(sentToProvider.text).not.toContain('01019012345');
    expect(sentToProvider.text).toMatch(/«ID_1»/);
    expect(outcome).toMatchObject({ result: { transcript: 'Id 01019012345 ok' } });
    const replies = client
      .map((m) => (m.kind === 'text' ? (JSON.parse(m.text) as { text?: string }).text : undefined))
      .filter((t): t is string => t !== undefined);
    expect(replies.join('')).toBe('Id 01019012345 ok');
    expect(replies.join('')).not.toContain('«');
  });

  it('ends the session on an event the descriptor does not declare', async () => {
    const where = await provider((peer) => {
      void (async () => {
        await settle(150);
        peer.send(text({ event: 'surprise' }));
      })();
    });
    const { outcome, audit } = await run(chat(), where, { topic: 'x' }, () => undefined);
    expect((outcome as { error: Error }).error.message).toMatch(
      /sent an event it does not declare \(surprise\)/,
    );
    expect(audit[0]).toMatchObject({ outcome: 'failed' });
  });

  it('refuses a client event the descriptor does not declare, and one outside its shape', async () => {
    const where = await provider(() => undefined);
    const first = await run(chat(), where, { topic: 'x' }, (c) =>
      c.push(text({ event: 'shout', text: 'hi' })),
    );
    expect((first.outcome as { error: Error }).error.message).toMatch(/does not declare \(shout\)/);
    const second = await run(chat(), where, { topic: 'x' }, (c) =>
      c.push(text({ event: 'say', text: 5 })),
    );
    expect((second.outcome as { error: Error }).error.message).toMatch(/outside its shape/);
    expect(where.received).toEqual([]);
  });

  it('fails the session with the kind the descriptor maps when the provider reports a failure', async () => {
    const where = await provider((peer) => {
      void (async () => {
        await settle(150);
        peer.send(text({ event: 'oops', reason: 'overloaded' }));
      })();
    });
    const { outcome } = await run(chat(), where, { topic: 'x' }, () => undefined);
    expect(outcome).toMatchObject({ error: { message: 'overloaded', kind: 'unavailable' } });
  });

  it('ends at the longest duration the descriptor allows', async () => {
    const short = parseDescriptor(
      readFileSync(join(here, 'testdata/descriptors/example/chat-session@1.yaml'), 'utf8').replace(
        'longestSeconds: 60',
        'longestSeconds: 1',
      ),
    );
    const where = await provider(() => undefined);
    const started = Date.now();
    const { outcome } = await run(short, where, { topic: 'x' }, () => undefined);
    expect(outcome).toMatchObject({ result: { end: 'longest' } });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('ends when the kind is demoted while the session runs', async () => {
    const where = await provider(() => undefined);
    let maturity: Maturity = 'production';
    const { outcome } = await run(
      chat(),
      where,
      { topic: 'x' },
      () => {
        maturity = 'test';
      },
      { synthetic: false, maturity: async () => maturity },
    );
    expect(outcome).toMatchObject({ result: { end: 'demoted' } });
  });

  it('ends when the caller cancels the run', async () => {
    const where = await provider(() => undefined);
    const abort = new AbortController();
    const { outcome } = await run(chat(), where, { topic: 'x' }, () => abort.abort(), { abort });
    expect(outcome).toMatchObject({ result: { end: 'cancelled' } });
  });

  it('ends when the caller closes', async () => {
    const where = await provider(() => undefined);
    const { outcome } = await run(chat(), where, { topic: 'x' }, (c) => c.close());
    expect(outcome).toMatchObject({ result: { end: 'closed' } });
  });

  it('stops a session that passes its message cap', async () => {
    const where = await provider(() => undefined);
    const { outcome } = await run(chat(), where, { topic: 'x' }, (c) => {
      for (let i = 0; i < 30; i += 1) c.push(text({ event: 'say', text: 'x' }));
    });
    expect((outcome as { error: Error }).error.message).toMatch(/passed 20 messages/);
  });

  it('stops a session whose message is over the size cap', async () => {
    const where = await provider(() => undefined);
    const { outcome } = await run(chat(), where, { topic: 'x' }, (c) =>
      c.push(text({ event: 'say', text: 'x'.repeat(5000) })),
    );
    expect((outcome as { error: Error }).error.message).toMatch(/over 4096/);
  });

  it('reports a provider that will not accept the session without the credential', async () => {
    const where = await provider(() => undefined);
    const { outcome } = await run(chat(), where, { topic: 'x' }, () => undefined, {
      baseURL: 'http://127.0.0.1:9/v1',
    });
    const message = (outcome as { error: Error }).error.message;
    expect(message).toMatch(/did not accept the session/);
    expect(message).not.toContain('connection-key');
  });

  it('a guard that must see the whole answer first cannot be used on a live session', async () => {
    const where = await provider(() => undefined);
    const { outcome } = await run(chat(), where, { topic: 'x' }, () => undefined, {
      guards: [{ holdsStream: true }],
    });
    expect((outcome as { error: Error }).error.message).toMatch(/streams as it goes/);
  });
});

describe('binary frames in a session are media under consent (E)', () => {
  const where = async () => provider(() => undefined);

  it('a binary frame goes out only when the service records consent for its media type, and is recorded by digest', async () => {
    const provided = await where();
    const refused = await run(
      chat(),
      provided,
      { topic: 'x' },
      (c) => c.push({ kind: 'binary', bytes: wavFrame }),
      {
        synthetic: false,
      },
    );
    expect((refused.outcome as { error: Error }).error.message).toMatch(
      /audio\/wav cannot be masked/,
    );
    const allowed = await run(
      chat(),
      provided,
      { topic: 'x' },
      async (c) => {
        c.push({ kind: 'binary', bytes: wavFrame });
        await settle(100);
        c.close();
      },
      {
        synthetic: false,
        unmaskedMedia: ['audio/wav'],
      },
    );
    expect(allowed.outcome).toMatchObject({ result: { end: 'closed' } });
    expect(allowed.audit[0]?.mediaInput).toEqual([
      expect.objectContaining({ mediaType: 'audio/wav', bytes: 8 }),
    ]);
    expect(provided.received).toEqual([{ kind: 'binary', bytes: wavFrame }]);
  });

  it('a binary frame from the provider is kept within the environment cap and relayed', async () => {
    const provided = await provider((peer) => {
      void (async () => {
        await settle(150);
        peer.send({ kind: 'binary', bytes: wavFrame });
        peer.send(text({ event: 'bye' }));
      })();
    });
    const { outcome, client } = await run(chat(), provided, { topic: 'x' }, () => undefined);
    expect(outcome).toMatchObject({ result: { end: 'done' } });
    expect(client[0]).toEqual({ kind: 'binary', bytes: wavFrame });
  });

  it('a session that takes no binary frames refuses one', async () => {
    const noBinary = parseDescriptor(
      readFileSync(join(here, 'testdata/descriptors/example/chat-session@1.yaml'), 'utf8').replace(
        '        binary: audio/wav\n        events:\n          open:',
        '        events:\n          open:',
      ),
    );
    const provided = await where();
    const { outcome } = await run(noBinary, provided, { topic: 'x' }, (c) =>
      c.push({ kind: 'binary', bytes: wavFrame }),
    );
    expect((outcome as { error: Error }).error.message).toMatch(/takes no binary frames/);
  });
});

describe('the OpenAI realtime transcription descriptor (F)', () => {
  it('turns audio frames into input_audio_buffer.append events and the deltas into a transcript', async () => {
    const provided = await provider((peer, p) => {
      void (async () => {
        while (p.received.length < 2) await settle(10);
        peer.send(text({ type: 'transcription_session.created', session: { id: 'sess_1' } }));
        peer.send(
          text({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Hei ' }),
        );
        peer.send(
          text({ type: 'conversation.item.input_audio_transcription.delta', delta: 'verden' }),
        );
        peer.send(
          text({
            type: 'conversation.item.input_audio_transcription.completed',
            transcript: 'Hei verden',
            usage: { type: 'tokens', input_tokens: 14, output_tokens: 6, total_tokens: 20 },
          }),
        );
        peer.close();
      })();
    });
    const { outcome, metered } = await run(
      realtime(),
      provided,
      { language: 'no' },
      (c) => {
        c.push(
          text({
            type: 'transcription_session.update',
            session: {
              input_audio_format: 'pcm16',
              input_audio_transcription: { model: 'gpt-4o-transcribe', language: 'no' },
              turn_detection: { type: 'server_vad' },
            },
          }),
        );
        c.push({ kind: 'binary', bytes: new Uint8Array([1, 2, 3, 4]) });
      },
      { synthetic: false, unmaskedMedia: ['audio/pcm'] },
    );
    expect(outcome).toMatchObject({ result: { transcript: 'Hei verden' } });
    expect(metered).toEqual([{ inputTokens: 14, outputTokens: 6, requests: 1 }]);
    expect(provided.requests[0]?.url).toBe('/v1/realtime?intent=transcription');
    expect(provided.requests[0]?.headers['openai-beta']).toBe('realtime=v1');
    const sent = provided.received.map((m) => (m.kind === 'text' ? JSON.parse(m.text) : m));
    expect(sent[1]).toEqual({ type: 'input_audio_buffer.append', audio: 'AQIDBA==' });
  });
});

describe('hostile session declarations (E, G)', () => {
  const yaml = readFileSync(join(here, 'testdata/descriptors/example/chat-session@1.yaml'), 'utf8');
  const refused = (text: string) => {
    try {
      parseDescriptor(text);
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it('a session that runs longer than the platform allows is refused', () => {
    expect(refused(yaml.replace('longestSeconds: 60', 'longestSeconds: 7200'))).toMatch(
      /longestSeconds/,
    );
  });

  it('a session message is an object, and carries no media or provider id', () => {
    expect(
      refused(
        yaml.replace(
          'event: { enum: [say] }\n                text: text',
          'event: { enum: [say] }\n                text: { media: audio/wav }',
        ),
      ),
    ).toMatch(/media goes in binary frames/);
    expect(
      refused(
        yaml.replace(
          'event: { enum: [say] }\n                text: text',
          () => "event: { enum: [say] }\n                text: { issued: '^a$' }",
        ),
      ),
    ).toMatch(/media goes in binary frames, never in a text message/);
    expect(
      refused(
        yaml.replace(
          'shape:\n              object:\n                event: { enum: [open] }\n                topic: text',
          'shape: text',
        ),
      ),
    ).toMatch(/a message is an object/);
  });

  it('a transcript points at a text field, so the gate can mask and restore it', () => {
    expect(refused(yaml.replace('transcript: $event.text', 'transcript: $event.event'))).toMatch(
      /transcript must point at a text field/,
    );
  });

  it('a session opens with a GET and no body, and is the last step', () => {
    expect(refused(yaml.replace('method: GET', 'method: POST'))).toBeDefined();
  });

  it('a session names its messages, and a binary-as event is a declared client event with an opaque field', () => {
    expect(
      refused(
        yaml.replace(
          '        binary: audio/wav\n        events:\n          open:',
          '        binary: audio/wav\n        binaryAs: { event: say, field: text }\n        events:\n          open:',
        ),
      ),
    ).toMatch(/is a declared client event whose text is opaque/);
    expect(
      refused(
        yaml.replace(
          '        name: $event.event\n        binary: audio/wav\n        events:\n          open:',
          '        binary: audio/wav\n        binaryAs: { event: say, field: text }\n        events:\n          open:',
        ),
      ),
    ).toMatch(/needs client.binary and client.name/);
  });

  it('a session does not read an answer: no wire.response, no until', () => {
    expect(
      refused(
        yaml.replace(
          '    wire:\n      query:\n        object: {}',
          '    wire:\n      response:\n        object: {}',
        ),
      ),
    ).toBeDefined();
  });

  it('a binary type is one media type', () => {
    expect(
      refused(
        yaml.replace(
          '        binary: audio/wav\n        events:\n          open:',
          '        binary: nonsense\n        events:\n          open:',
        ),
      ),
    ).toMatch(/is one media type/);
  });
});
