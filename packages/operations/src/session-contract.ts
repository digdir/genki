import { isDeepStrictEqual } from 'node:util';
import { createGate, type GateRecord, type PortContext } from '@genai/kernel';
import type { Usage } from '@genai/contracts';
import type { Descriptor } from './descriptor.js';
import { describedSession, type SessionIO } from './session.js';
import type { ProviderSocket, WsMessage } from './websocket.js';

export interface SessionFixtureMessage {
  from: 'client' | 'server';
  message: unknown;
  /** Base64 audio or other bytes the caller sends as a binary frame, which the provider receives as `message`. */
  binary?: string;
}

export interface SessionFixture {
  request: { path: string; query?: Record<string, string>; headers?: Record<string, string> };
  messages: SessionFixtureMessage[];
}

const queue = <T>() => {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  return {
    push(item: T) {
      items.push(item);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    iterable: {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
        next: async () => {
          while (items.length === 0 && !done) await new Promise<void>((r) => (wake = r));
          return items.length > 0
            ? { value: items.shift() as T, done: false }
            : { value: undefined, done: true };
        },
      }),
    } as AsyncIterable<T>,
  };
};

const textOf = (value: unknown): WsMessage => ({ kind: 'text', text: JSON.stringify(value) });

const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

export interface SessionCase {
  deployment: string;
  input: unknown;
  session: SessionFixture;
  result: unknown;
  usage: Usage;
}

export interface SessionRun {
  outcome: { result: unknown; usage: Usage } | { error: unknown };
  seenByProvider: unknown[];
  url: string | undefined;
  headers: Record<string, string>;
  metered: Usage[];
  audit: GateRecord[];
}

/** Replays a recorded session: the provider answers each recorded client message with the server messages recorded after it. */
export const replaySession = async (
  descriptor: Descriptor,
  fixture: SessionCase,
  options: { extraServerMessage?: unknown; key: string },
): Promise<SessionRun> => {
  const script = fixture.session.messages;
  const fromProvider = queue<WsMessage>();
  const seenByProvider: unknown[] = [];
  let url: string | undefined;
  let headers: Record<string, string> = {};
  const clients = script.filter((m) => m.from === 'client').length;
  let received = 0;
  let cursor = 0;
  const emitServer = () => {
    while (cursor < script.length && script[cursor]?.from === 'server')
      fromProvider.push(textOf(script[cursor++]?.message));
  };
  const finishIfDone = () => {
    if (received < clients || cursor < script.length) return;
    fromProvider.end();
  };
  const provider: ProviderSocket = {
    messages: () => fromProvider.iterable,
    send: (message) => {
      seenByProvider.push(message.kind === 'text' ? JSON.parse(message.text) : message);
      received += 1;
      while (cursor < script.length && script[cursor]?.from === 'client') cursor += 1;
      emitServer();
      finishIfDone();
    },
    close: () => fromProvider.end(),
  };
  const fromCaller = queue<WsMessage>();
  const io: SessionIO = { incoming: fromCaller.iterable, send: () => undefined };
  const metered: Usage[] = [];
  const audit: GateRecord[] = [];
  const ctx: PortContext = {
    tenant: '999888777',
    principal: { kind: 'operator', issuer: 'test', subject: 'contract' },
    task: 'operation-contract',
    signal: new AbortController().signal,
    meter: async (u) => void metered.push(u),
    audit: async (r) => void audit.push(r),
  };
  const outcome = describedSession(
    {
      gate: createGate({
        media: {
          allows: () => true,
          maxBytes: () => 1_000_000,
          keep: async (k) => ({ tenant: k.tenant, path: 'kept/1', sha256: 'abc' }),
        },
      }),
      ctx,
      target: {
        port: 'operation',
        operation: descriptor.operation,
        model: { kind: 'model', id: 'contract/model' },
        endpoint: 'contract',
        residency: 'norway',
        admission: 'open',
        synthetic: true,
      },
      descriptor,
      endpoint: {
        baseURL: 'https://contract.invalid/base',
        credential: { kind: 'api-key', key: async () => options.key },
        connection: 'contract',
        tenant: '999888777',
        run: 'operation-contract',
        connect: async (target, sent) => {
          url = target;
          headers = sent;
          if (options.extraServerMessage !== undefined)
            fromProvider.push(textOf(options.extraServerMessage));
          emitServer();
          return provider;
        },
      },
      deployment: fixture.deployment,
    },
    fixture.input,
    io,
  ).then(
    (result) => ({ result: result.result, usage: result.usage }),
    (error: unknown) => ({ error }),
  );
  await new Promise((r) => setTimeout(r, 0));
  for (const m of script)
    if (m.from === 'client')
      fromCaller.push(m.binary ? { kind: 'binary', bytes: bytesOf(m.binary) } : textOf(m.message));
  if (clients === 0) finishIfDone();
  const settled = await outcome;
  fromCaller.end();
  return { outcome: settled, seenByProvider, url, headers, metered, audit };
};

const same = (label: string, actual: unknown, expected: unknown) =>
  isDeepStrictEqual(actual, expected)
    ? []
    : [`${label} differs: got ${JSON.stringify(actual)}, recorded ${JSON.stringify(expected)}`];

export const sessionChecks = (key: string) => [
  {
    name: 'the messages sent to the provider and the connection are the recorded ones',
    run: async (descriptor: Descriptor, fixture: SessionCase) => {
      const run = await replaySession(descriptor, fixture, { key });
      if ('error' in run.outcome) return [`the session failed: ${String(run.outcome.error)}`];
      const url = new URL(run.url ?? 'ws://invalid');
      const wanted = fixture.session.messages
        .filter((m) => m.from === 'client')
        .map((m) => m.message);
      const sentHeaders = Object.fromEntries(
        Object.entries(run.headers).filter(
          ([h]) => h.toLowerCase() in lower(fixture.session.request.headers),
        ),
      );
      return [
        ...same('path', url.pathname.replace(/^\/base/, ''), fixture.session.request.path),
        ...same('query', Object.fromEntries(url.searchParams), fixture.session.request.query ?? {}),
        ...same('headers', lowered(sentHeaders), lowered(fixture.session.request.headers ?? {})),
        ...same('messages', run.seenByProvider, wanted),
        ...(Object.values(run.headers).some((v) => v.includes(key))
          ? []
          : ['the endpoint credential was not sent']),
      ];
    },
  },
  {
    name: 'the recorded provider messages map to the typed result',
    run: async (descriptor: Descriptor, fixture: SessionCase) => {
      const run = await replaySession(descriptor, fixture, { key });
      if ('error' in run.outcome) return [`the session failed: ${String(run.outcome.error)}`];
      return same('result', run.outcome.result, fixture.result);
    },
  },
  {
    name: 'usage is mapped and metered',
    run: async (descriptor: Descriptor, fixture: SessionCase) => {
      const run = await replaySession(descriptor, fixture, { key });
      return [
        ...same('metered usage', run.metered, [fixture.usage]),
        ...same('audited usage', run.audit[0]?.usage, fixture.usage),
      ];
    },
  },
  {
    name: 'a provider message the descriptor does not declare ends the session as an error',
    run: async (descriptor: Descriptor, fixture: SessionCase) => {
      const run = await replaySession(descriptor, fixture, {
        key,
        extraServerMessage: { unrecorded_event: true },
      });
      return 'error' in run.outcome ? [] : ['the session went on after an undeclared message'];
    },
  },
];

const lower = (headers: Record<string, string> | undefined) =>
  Object.fromEntries(Object.keys(headers ?? {}).map((h) => [h.toLowerCase(), true]));

const lowered = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([h, v]) => [h.toLowerCase(), v]));
