import type { Input, SchemaLabels } from '@genai/contracts';
import type { InvocationContext, Strategy } from '@genai/kernel';
import { z } from 'zod';
import { descriptorIdPattern } from './descriptor.js';
import type { SessionIO, SessionOutcome } from './session.js';

export const liveSessionConfig = z.strictObject({
  descriptor: z.string().regex(descriptorIdPattern),
  model: z.string().min(1).optional(),
});

export const liveSessionRuntimeConfig = z.looseObject({
  strategy: liveSessionConfig,
  model: z.looseObject({
    primary: z.string().min(1),
    tenant: z.string().min(1).optional(),
    operations: z.record(z.string(), z.string()).optional(),
  }),
});

export type LiveSessionRuntimeConfig = z.infer<typeof liveSessionRuntimeConfig>;

interface SessionPort {
  session(descriptor: string, input: unknown, io: SessionIO): Promise<SessionOutcome>;
}

/** Where a run waits for the connection that carries its session; the route that accepts the connection hands it over. */
export class SessionChannels {
  readonly #waiting = new Map<string, (io: SessionIO) => void>();
  readonly #ready = new Map<string, SessionIO>();

  provide(task: string, io: SessionIO) {
    const waiting = this.#waiting.get(task);
    if (waiting) {
      this.#waiting.delete(task);
      waiting(io);
    } else this.#ready.set(task, io);
  }

  claim(task: string, signal: AbortSignal, timeoutMs = 15_000): Promise<SessionIO> {
    const ready = this.#ready.get(task);
    if (ready) {
      this.#ready.delete(task);
      return Promise.resolve(ready);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(task);
        reject(new Error('no connection arrived for the session'));
      }, timeoutMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        this.#waiting.delete(task);
        reject(new Error('the session was cancelled before it began'));
      });
      this.#waiting.set(task, (io) => {
        clearTimeout(timer);
        resolve(io);
      });
    });
  }
}

const kindOf = (descriptor: string) => /^[^/]+\/([^@]+)@/.exec(descriptor)?.[1] ?? '';

/** The way of working `live-session@1`: one run is one live session on the descriptor its config names. */
export const liveSession = (channels: SessionChannels): Strategy<LiveSessionRuntimeConfig> => ({
  id: 'live-session',
  version: '1',
  requires: { kernel: 1, ports: ['described'], features: [] },
  run: async function* (ctx: InvocationContext, input: Input, raw: LiveSessionRuntimeConfig) {
    const config = liveSessionRuntimeConfig.parse(raw);
    const { descriptor } = config.strategy;
    const model =
      config.strategy.model ??
      config.model.operations?.[kindOf(descriptor)] ??
      config.model.primary;
    const port = await ctx.use<SessionPort>('described', {
      kind: 'model',
      id: model,
      tenant: config.model.tenant ?? ctx.tenant,
    });
    if (!port.session) throw new Error(`${descriptor} cannot run as a live session here`);
    const io = await channels.claim(ctx.task, ctx.signal);
    const opened = (input.data ?? {}) as Record<string, unknown>;
    let outcome;
    try {
      outcome = await port.session(descriptor, opened, io);
    } catch (error) {
      io.close?.('error');
      throw error;
    }
    io.close?.(outcome.end);
    yield {
      type: 'kernel.result',
      data: [
        {
          mime: 'text/plain',
          body: { kind: 'text', text: outcome.transcript },
          meta: { end: outcome.end, messages: outcome.messages },
        },
      ],
    };
  },
});

export const liveSessionSchemaLabels: SchemaLabels = {
  nb: {
    descriptor: {
      label: 'Beskrivelse av direkteøkten',
      help: 'Id-en til en gjennomgått operasjonsbeskrivelse, for eksempel openai/realtime-transcription@1.',
    },
    model: { label: 'Modell' },
  },
  en: {
    descriptor: {
      label: 'Live session descriptor',
      help: 'The id of a reviewed operation descriptor, for example openai/realtime-transcription@1.',
    },
    model: { label: 'Model' },
  },
  titles: { 'live-session': { nb: 'Direkte økt', en: 'Live session' } },
};
