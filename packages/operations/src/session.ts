import type { Usage } from '@genai/contracts';
import {
  ShapeError,
  walk,
  withoutTrailingSlashes,
  type Gate,
  type GateSession,
  type GateTarget,
  type Maturity,
  type PortContext,
} from '@genai/kernel';
import type { Descriptor, SessionEvent, Step } from './descriptor.js';
import {
  executorInternals,
  OperationError,
  type DescribedEndpoint,
  type SendOptions,
} from './executor.js';
import { evaluate } from './mapping.js';
import { connectWebSocket, type ProviderSocket, type WsMessage } from './websocket.js';

const { newState, prepare, credentialFor, runStep, checkParts, readsOnly, lookupPath, addUsage } =
  executorInternals;

export interface SessionIO {
  /** What the caller sends, until the caller closes. */
  incoming: AsyncIterable<WsMessage>;
  /** What goes back to the caller. */
  send(message: WsMessage): void;
  close?(end: SessionEnd | 'error'): void;
}

export interface DescribedSessionCall {
  gate: Gate;
  ctx: PortContext;
  target: GateTarget;
  descriptor: Descriptor;
  endpoint: DescribedEndpoint;
  deployment: string;
  priced?: (usage: Usage) => Usage;
  fail?: SendOptions['fail'];
  /** The kind's maturity now; the session ends when it no longer admits the call. */
  maturity?: () => Promise<Maturity>;
  maturityEveryMs?: number;
}

export type SessionEnd = 'done' | 'closed' | 'longest' | 'demoted' | 'cancelled';

export interface SessionOutcome {
  end: SessionEnd;
  result: unknown;
  transcript: string;
  usage: Usage;
  messages: number;
}

const wsUrl = (base: string, path: string) => {
  const url = new URL(`${withoutTrailingSlashes(base)}${path}`);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url;
};

const nested = (path: readonly string[], value: string): Record<string, unknown> =>
  path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;

const nameOf = (message: unknown, path: string[] | undefined) => {
  const named = path ? lookupPath(message, path) : undefined;
  return typeof named === 'string' ? named : '';
};

/** Runs a descriptor's live session: every message both ways passes the gate, and the run is the session. */
export const describedSession = async (
  call: DescribedSessionCall,
  input: unknown,
  io: SessionIO,
): Promise<SessionOutcome> => {
  const { descriptor, endpoint, ctx } = call;
  const step = descriptor.steps.at(-1) as Step;
  const spec = step.session;
  if (!spec) throw new ShapeError(`${descriptor.id} is not a live session`);
  const at = `${descriptor.id} step ${step.name}`;
  const fail = call.fail ?? ((status, message, kind) => new OperationError(status, message, kind));
  const options: SendOptions = { signal: ctx.signal, fail };
  const session: GateSession = await call.gate.session(
    ctx,
    { ...call.target, descriptor: descriptor.id },
    {
      ...(spec.client.binary ? { binaryIn: spec.client.binary } : {}),
      ...(spec.server.binary ? { binaryOut: spec.server.binary } : {}),
    },
  );
  const usage: Usage = {};
  let transcript = '';
  let messages = 0;
  let end: SessionEnd | undefined;
  let failure: unknown;
  let provider: ProviderSocket | undefined;
  let finished: () => void = () => undefined;
  const over = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const stop = (why: SessionEnd, error?: unknown) => {
    if (end !== undefined) return;
    end = why;
    failure = error;
    finished();
  };
  const state = newState(undefined, call.deployment);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const cleanup = async () => {
    for (const t of timers) clearTimeout(t);
    provider?.close();
    for (const s of descriptor.finally) {
      if (!readsOnly(s, state.ran)) continue;
      await runStep(descriptor, s, endpoint, state, options, fail).catch(() => undefined);
    }
  };
  try {
    state.input = await session.outbound(descriptor.input, input);
    checkParts(descriptor, state.input, fail);
    for (const earlier of descriptor.steps.slice(0, -1))
      await runStep(descriptor, earlier, endpoint, state, options, fail);
    const prepared = prepare(descriptor, step, endpoint, state, options);
    const credential = await credentialFor(step, endpoint, state);
    const url = wsUrl(endpoint.baseURL, prepared.path);
    for (const [name, value] of Object.entries({
      ...descriptor.api.query,
      ...prepared.query,
      ...credential.query,
    }))
      url.searchParams.set(name, value);
    provider = await (endpoint.connect ?? connectWebSocket)(
      url.toString(),
      { ...descriptor.api.headers, ...prepared.headers, ...credential.headers },
      ctx.signal,
    ).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw fail(
        undefined,
        `${at}: ${message.replaceAll(credential.value, '[redacted]')}`,
        'unavailable',
      );
    });
    const counted = (bytes: number) => {
      messages += 1;
      if (messages > spec.maxMessages)
        throw fail(undefined, `${at}: the session passed ${spec.maxMessages} messages`);
      if (bytes > spec.maxMessageBytes)
        throw fail(undefined, `${at}: a message of ${bytes} bytes is over ${spec.maxMessageBytes}`);
    };
    const fromProvider = async (message: WsMessage) => {
      if (message.kind === 'binary') {
        if (!spec.server.binary)
          throw fail(undefined, `${at}: the provider sent a binary frame it does not declare`);
        counted(message.bytes.byteLength);
        session.inboundBinary(spec.server.binary, message.bytes);
        io.send(message);
        return;
      }
      counted(Buffer.byteLength(message.text));
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.text);
      } catch {
        throw fail(undefined, `${at}: the provider sent a message that is not JSON`);
      }
      const name = nameOf(parsed, spec.server.name);
      const event: SessionEvent | undefined = spec.server.events[name];
      if (!event)
        throw fail(
          undefined,
          `${at}: the provider sent an event it does not declare (${name.slice(0, 64)}), so the session is ended`,
        );
      const walked = session.inbound(event.shape, parsed, event.transcript);
      if (event.fail) {
        const mapped = evaluate(event.fail.message, { event: walked });
        throw fail(
          undefined,
          typeof mapped === 'string'
            ? mapped.slice(0, 500)
            : `${at}: the provider reported a failure`,
          event.fail.kind,
        );
      }
      if (event.usage) {
        const used: Usage = {};
        addUsage(used, evaluate(event.usage, { event: walked }));
        const priced = call.priced ? call.priced(used) : used;
        await session.meter(priced);
        addUsage(usage, priced);
      }
      if (event.transcript) {
        const piece = lookupPath(walked, event.transcript);
        if (typeof piece === 'string') transcript += piece;
      }
      io.send({ kind: 'text', text: JSON.stringify(walked) });
      if (event.done) stop('done');
    };
    const fromClient = async (message: WsMessage) => {
      if (message.kind === 'binary') {
        if (!spec.client.binary)
          throw fail(undefined, `${at}: this session takes no binary frames`);
        counted(message.bytes.byteLength);
        const bytes = await session.outboundBinary('binary', spec.client.binary, message.bytes);
        const as = spec.client.binaryAs;
        provider?.send(
          as
            ? {
                kind: 'text',
                text: JSON.stringify({
                  ...nested(spec.client.name ?? [], as.event),
                  [as.field]: Buffer.from(bytes).toString('base64'),
                }),
              }
            : { kind: 'binary', bytes },
        );
        return;
      }
      counted(Buffer.byteLength(message.text));
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.text);
      } catch {
        throw fail(undefined, `${at}: a client message is not JSON`);
      }
      const name = nameOf(parsed, spec.client.name);
      const event = spec.client.events[name];
      if (!event)
        throw fail(
          undefined,
          `${at}: the client sent an event the session does not declare (${name.slice(0, 64)})`,
        );
      const sent = await session.outbound(event.shape, parsed);
      provider?.send({ kind: 'text', text: JSON.stringify(sent) });
    };
    const pump = async <T>(source: AsyncIterable<T>, handle: (item: T) => Promise<void>) => {
      try {
        for await (const item of source) {
          if (end !== undefined) return;
          await handle(item);
        }
        stop('closed');
      } catch (error) {
        stop('closed', error);
      }
    };
    timers.push(setTimeout(() => stop('longest'), spec.longestSeconds * 1000));
    if (call.maturity) {
      const check = setInterval(() => {
        void (call.maturity as () => Promise<Maturity>)().then((m) => {
          if (!session.stillAdmitted(m)) stop('demoted');
        });
      }, call.maturityEveryMs ?? 1000) as unknown as ReturnType<typeof setTimeout>;
      timers.push(check);
    }
    ctx.signal.addEventListener('abort', () => stop('cancelled'));
    void pump(provider.messages(), fromProvider);
    void pump(io.incoming, fromClient);
    await over;
    await cleanup();
    transcript += session.flush();
    if (failure !== undefined) throw failure;
    const mapped = evaluate(descriptor.result, {
      response: { transcript },
      headers: {},
      input: state.input,
      deployment: call.deployment,
      usage,
      dropped: 0,
      steps: state.steps,
    });
    const checked = walk(descriptor.output, mapped, { side: 'result' });
    if (checked.problems.length > 0)
      throw new ShapeError(
        `${at}: the result is outside its shape: ${checked.problems.join('; ')}`,
      );
    await session.end('ok');
    return { end: end as SessionEnd, result: checked.value, transcript, usage, messages };
  } catch (error) {
    await cleanup().catch(() => undefined);
    await session.end('failed').catch(() => undefined);
    throw error;
  }
};

export const sessionOfDescriptor = (descriptor: Descriptor) =>
  descriptor.steps.at(-1)?.session !== undefined;
