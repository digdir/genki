import type { Principal, Ref, ResourceProvenance, Usage } from '@genai/contracts';
import {
  decodeBase64,
  defaultMediaOutputMaxBytes,
  isInlineMedia,
  isMediaInput,
  isMediaRef,
  mediaInputKind,
  mediaTypeCovers,
  sha256Hex,
  type MediaInput,
  type MediaInputSource,
  type MediaOutput,
} from './media.js';
import {
  mediaTypesOf,
  walk,
  type MediaInputFound,
  type Shape,
  type OperationShape,
  type Walked,
} from './payload.js';
import type { PortContext } from './spi.js';
import { addUsage } from './usage-sum.js';

export const residencies = ['norway', 'eu', 'global'] as const;
export type Residency = (typeof residencies)[number];

export const residencyAllows = (allowed: Residency, actual: Residency) =>
  residencies.indexOf(actual) <= residencies.indexOf(allowed);

export const narrowerResidency = (a: Residency | undefined, b: Residency | undefined) =>
  a === undefined ? b : b === undefined ? a : residencyAllows(a, b) ? b : a;

export type Admission = 'admitted' | 'open';

export type GateRefusal =
  | 'admission'
  | 'disabled'
  | 'not-shared'
  | 'residency'
  | 'maturity'
  | 'processor'
  | 'media'
  | 'shape';

export const environmentTiers = ['test', 'production'] as const;
export type EnvironmentTier = (typeof environmentTiers)[number];

export const maturities = ['test', 'production'] as const;
export type Maturity = (typeof maturities)[number];

/** A kind in test serves only synthetic calls in a test environment; a kind in production serves any call. */
export const maturityAdmits = (maturity: Maturity, tier: EnvironmentTier, synthetic: boolean) =>
  maturity === 'production' || (tier === 'test' && synthetic);

export class GateError extends Error {
  constructor(
    readonly refusal: GateRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
  }
}

export interface GateCall {
  port: string;
  operation: string;
  model: string;
}

export interface Masker {
  mask(text: string): string;
  unmask?(text: string): string;
  /** How many characters at the end of streamed text may start a token and must wait. */
  pending?(text: string): number;
}

export interface PayloadGuard {
  masker?: Masker;
  holdsStream?: boolean;
  request?(call: GateCall, body: unknown): unknown;
  result?(call: GateCall, body: unknown): unknown;
}

export interface UseOptions {
  guards?: readonly PayloadGuard[];
  serviceResidency?: Residency;
  /** Media types the service's confirmed risk assessment lets out unmasked (#326). */
  unmaskedMedia?: readonly string[];
}

export const withUse = (given: UseOptions | undefined, own: UseOptions): UseOptions => {
  const guards = [...(given?.guards ?? []), ...(own.guards ?? [])];
  const serviceResidency = narrowerResidency(given?.serviceResidency, own.serviceResidency);
  const unmaskedMedia = own.unmaskedMedia ?? given?.unmaskedMedia;
  return {
    ...(guards.length > 0 ? { guards } : {}),
    ...(serviceResidency ? { serviceResidency } : {}),
    ...(unmaskedMedia?.length ? { unmaskedMedia } : {}),
  };
};

export interface MediaInputRecord {
  path: string;
  mediaType: string;
  bytes: number;
  sha256: string;
}

export interface GateRecord {
  port: string;
  operation: string;
  model: string;
  endpoint?: string;
  descriptor?: string;
  residency: Residency;
  outcome: 'ok' | 'refused' | 'failed';
  refusal?: GateRefusal | 'guard';
  usage?: Usage;
  dropped?: number;
  mediaBytes?: number;
  mediaInput?: MediaInputRecord[];
}

export interface GateTarget {
  port: string;
  operation: string;
  model: Ref;
  endpoint?: string;
  descriptor?: string;
  residency: Residency;
  admission: Admission;
  enabled?: boolean;
  tenants?: readonly string[];
  tenant?: string;
  routerResidency?: Residency;
  requestResidency?: Residency;
  maturity?: Maturity;
  synthetic?: boolean;
  processorRecord?: boolean;
  /** Says why a connection without a processor record is refused, when the descriptor needs more than the record. */
  processorNote?: string;
  refuse?: (refusal: GateRefusal, message: string) => Error;
}

export interface GatePayload<Res> {
  shape: OperationShape;
  usage?(result: Res): Usage | undefined;
  provenance?(result: Res): ResourceProvenance | undefined;
  /** Fields the adapter dropped from the provider's answer before it reached the port. */
  dropped?(result: Res): number | undefined;
}

export type GateChunk<Res> = { kind: 'delta'; text: string } | { kind: 'done'; result: Res };

export interface OutsideRun {
  audit(ctx: PortContext, record: GateRecord): Promise<void>;
  meter(ctx: PortContext, usage: Usage, model: Ref): Promise<void>;
}

export interface GateOptions {
  admits?: (principal: Principal) => boolean;
  egress?: (endpoint: string) => typeof fetch | undefined;
  outside?: OutsideRun;
  tier?: EnvironmentTier;
  media?: MediaOutput;
  mediaInput?: MediaInputSource;
}

export interface GateSession {
  /** A text message to the provider: walked as a request, masked, and held to the guards. */
  outbound(shape: Shape, message: unknown): Promise<unknown>;
  /** A binary frame to the provider: media that needs the service's recorded consent and stays under the cap. */
  outboundBinary(path: string, type: string, bytes: Uint8Array): Promise<Uint8Array>;
  /** A message from the provider: walked as a result and restored; the text at `hold` waits for a token cut in two. */
  inbound(shape: Shape, message: unknown, hold?: readonly string[]): unknown;
  /** A binary frame from the provider: media the environment keeps, within its cap. */
  inboundBinary(type: string, bytes: Uint8Array): void;
  /** What the held text ends with, restored; call once when the session ends. */
  flush(): string;
  /** Whether the kind is still admitted at this maturity; false ends the session. */
  stillAdmitted(maturity: Maturity): boolean;
  meter(usage: Usage): Promise<void>;
  end(outcome: 'ok' | 'failed'): Promise<void>;
}

export interface GateSessionOptions {
  binaryIn?: string;
  binaryOut?: string;
}

export interface Gate {
  /** The fetch an adapter gets for an endpoint; the gate applies the endpoint's egress guard on every request. */
  egress(endpoint: string): typeof fetch;
  call<Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    request: Req,
    send: (request: Req) => Promise<Res>,
  ): Promise<Res>;
  stream<Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    request: Req,
    send: (request: Req) => AsyncIterable<GateChunk<Res>>,
  ): AsyncIterable<GateChunk<Res>>;
  /** A live session: the gate admits it once, then walks every message both ways until it ends. */
  session(ctx: PortContext, target: GateTarget, options?: GateSessionOptions): Promise<GateSession>;
}

const distinct = <T>(items: readonly T[]) => [...new Set(items)];

export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}

export const createGate = (options: GateOptions = {}): Gate => {
  const admit = (ctx: PortContext, target: GateTarget) => {
    const name = `${target.model.kind} ${target.model.id}`;
    const refuse = (refusal: GateRefusal, message: string) => {
      throw new GateError(refusal, message);
    };
    if (target.admission === 'admitted' && options.admits && !options.admits(ctx.principal))
      refuse('admission', 'this caller may not use models in this environment');
    if (target.enabled === false) refuse('disabled', `${name} is turned off`);
    if (target.tenants && !target.tenants.includes(target.tenant ?? ctx.tenant))
      refuse('not-shared', `${name} is not shared with this tenant`);
    for (const ceiling of [target.routerResidency, target.requestResidency, ctx.serviceResidency])
      if (ceiling && !residencyAllows(ceiling, target.residency))
        refuse('residency', `${name} runs outside ${ceiling}`);
    const synthetic = target.synthetic === true;
    if (
      target.maturity &&
      !maturityAdmits(target.maturity, options.tier ?? 'production', synthetic)
    )
      refuse(
        'maturity',
        `the ${target.operation} operation is in test: it serves only synthetic calls in a test environment`,
      );
    if (target.processorRecord === false && !synthetic)
      refuse(
        'processor',
        target.processorNote ??
          `endpoint ${target.endpoint ?? ''} has no processor record, so it cannot carry real data`,
      );
  };

  const mediaAdmitted = <Res>(payload: GatePayload<Res>) => {
    for (const type of mediaTypesOf(payload.shape.result))
      if (!options.media?.allows(type))
        throw new GateError(
          'media',
          `this environment keeps no ${type} output; an operator allows the media type first`,
        );
  };

  const inShape = <Req, Res>(
    payload: GatePayload<Res>,
    body: unknown,
    map?: (text: string) => string,
  ): Req => {
    const walked = walk<Req>(payload.shape.request, body, {
      side: 'request',
      ...(map ? { map } : {}),
    });
    if (walked.media.length > 0)
      throw new GateError(
        'media',
        'the payload has image, audio or file content, which cannot be masked',
      );
    if (walked.problems.length > 0)
      throw new GateError(
        'shape',
        `the request is outside its shape: ${walked.problems.join('; ')}`,
      );
    return walked.value;
  };

  const consented = (ctx: PortContext, target: GateTarget, inputs: MediaInputFound[]) => {
    if (target.synthetic === true) return;
    const rules = ctx.unmaskedMedia ?? [];
    for (const found of inputs)
      if (!rules.some((rule) => mediaTypeCovers(rule, found.type)))
        throw new GateError(
          'media',
          `${found.path}: ${found.type} cannot be masked, and the service's confirmed risk assessment records no unmasked input of it`,
        );
  };

  const mediaBytesOf = async (ctx: PortContext, found: MediaInputFound) => {
    const v = found.value;
    if (isMediaInput(v)) return v.body;
    if (isMediaRef(v)) {
      if (v.tenant !== ctx.tenant)
        throw new GateError('media', `${found.path}: the media belongs to another tenant`);
      const body = await options.mediaInput?.read(ctx, v);
      if (!body) throw new GateError('media', `${found.path}: the media is not kept for this run`);
      return body;
    }
    const body = decodeBase64(isInlineMedia(v) ? v.data : String(v));
    if (!body) throw new GateError('shape', `${found.path}: the media is not base64`);
    return body;
  };

  const readMedia = async <Req, Res>(
    ctx: PortContext,
    payload: GatePayload<Res>,
    body: Req,
  ): Promise<{ body: Req; records: MediaInputRecord[] }> => {
    const found = walk(payload.shape.request, body, { side: 'request' }).inputs;
    if (found.length === 0) return { body, records: [] };
    const resolved = new Map<unknown, MediaInput>();
    const records: MediaInputRecord[] = [];
    for (const input of found) {
      const bytes = await mediaBytesOf(ctx, input);
      const cap = options.media?.maxBytes(input.type) ?? defaultMediaOutputMaxBytes;
      if (bytes.byteLength > cap)
        throw new GateError(
          'media',
          `${input.path}: ${bytes.byteLength} bytes of ${input.type} is over the cap of ${cap} bytes`,
        );
      const media: MediaInput = {
        kind: mediaInputKind,
        mediaType: input.type,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        body: bytes,
      };
      resolved.set(input.value, media);
      records.push({
        path: input.path,
        mediaType: media.mediaType,
        bytes: media.bytes,
        sha256: media.sha256,
      });
    }
    const walked = walk<Req>(payload.shape.request, body, {
      side: 'request',
      mapMedia: (v) => resolved.get(v) ?? v,
    });
    return { body: walked.value, records };
  };

  const answered = <Res>(
    payload: GatePayload<Res>,
    result: unknown,
    map?: (text: string) => string,
    keepMedia = false,
  ) => {
    const walked = walk<Res>(payload.shape.result, result, {
      side: 'result',
      ...(map ? { map } : {}),
      ...(keepMedia ? { keepMedia } : {}),
    });
    if (walked.problems.length > 0)
      throw new ShapeError(
        `the provider answered outside the shape: ${walked.problems.join('; ')}`,
      );
    return walked;
  };

  const guarded = async <Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    request: Req,
  ) => {
    consented(ctx, target, walk(payload.shape.request, request, { side: 'request' }).inputs);
    inShape(payload, request);
    const guards = distinct(ctx.guards ?? []);
    const maskers = distinct(guards.flatMap((g) => (g.masker ? [g.masker] : [])));
    const call: GateCall = {
      port: target.port,
      operation: target.operation,
      model: target.model.id,
    };
    let body: Req = maskers.length
      ? inShape(payload, request, (text) => maskers.reduce((t, m) => m.mask(t), text))
      : request;
    for (const guard of guards) if (guard.request) body = (await guard.request(call, body)) as Req;
    body = inShape(payload, body);
    consented(ctx, target, walk(payload.shape.request, body, { side: 'request' }).inputs);
    const read = await readMedia(ctx, payload, body);
    body = read.body;
    const restoring = maskers.filter((m) => m.unmask);
    const restore = (text: string) =>
      restoring.reduceRight((t, m) => (m.unmask ? m.unmask(t) : t), text);
    const finish = async (result: Res) => {
      for (const guard of [...guards].reverse()) if (guard.result) await guard.result(call, result);
      return restoring.length ? answered(payload, result, restore).value : result;
    };
    const pending = (text: string) => Math.max(0, ...restoring.map((m) => m.pending?.(text) ?? 0));
    return {
      body,
      mediaInput: read.records,
      finish,
      restore,
      pending,
      holds: guards.some((g) => g.holdsStream),
      restores: restoring.length > 0,
    };
  };

  // Only the kernel's `use` sets audit, so a context without it comes from outside a run.
  const outside = (ctx: PortContext) => (ctx.audit ? undefined : options.outside);

  const recorder = (
    ctx: PortContext,
    target: GateTarget,
    noted: Pick<GateRecord, 'mediaInput'> = {},
  ) => {
    let written = false;
    const sink = outside(ctx);
    const audit = ctx.audit ?? (sink ? (record: GateRecord) => sink.audit(ctx, record) : undefined);
    return async (
      outcome: GateRecord['outcome'],
      extra: Pick<GateRecord, 'refusal' | 'usage' | 'dropped'> = {},
    ) => {
      if (written) return;
      written = true;
      await audit?.({
        port: target.port,
        operation: target.operation,
        model: target.model.id,
        ...(target.endpoint ? { endpoint: target.endpoint } : {}),
        ...(target.descriptor ? { descriptor: target.descriptor } : {}),
        residency: target.residency,
        outcome,
        ...extra,
        ...(noted.mediaInput?.length ? { mediaInput: noted.mediaInput } : {}),
      });
    };
  };

  const open = async <Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    request: Req,
    record: ReturnType<typeof recorder>,
  ) => {
    try {
      admit(ctx, target);
      mediaAdmitted(payload);
      return await guarded(ctx, target, payload, request);
    } catch (error) {
      if (!(error instanceof GateError)) {
        await record('refused', { refusal: 'guard' });
        throw error;
      }
      await record('refused', { refusal: error.refusal });
      throw target.refuse?.(error.refusal, error.message) ?? error;
    }
  };

  const received = async <Res>(
    payload: GatePayload<Res>,
    result: unknown,
    record: ReturnType<typeof recorder>,
  ) => {
    try {
      const walked = answered(payload, result, undefined, true);
      return {
        result: walked.value,
        dropped: walked.dropped + (payload.dropped?.(walked.value) ?? 0),
        outputs: walked.outputs,
      };
    } catch (error) {
      await record('failed');
      throw error;
    }
  };

  const oversized = (outputs: Walked['outputs']) => {
    for (const found of outputs) {
      const type = found.ref.mediaType;
      if (!options.media?.allows(type))
        return `${found.path}: this environment keeps no ${type} output`;
      const cap = options.media.maxBytes(type);
      if (found.body.byteLength > cap)
        return `${found.path}: ${found.body.byteLength} bytes of ${type} is over the cap of ${cap} bytes`;
    }
    return undefined;
  };

  const keep = async (ctx: PortContext, outputs: Walked['outputs']) => {
    for (const found of outputs) {
      const kept = await (options.media as MediaOutput).keep(ctx, found.body, found.ref.mediaType);
      Object.assign(found.ref, kept);
    }
  };

  const settle = async <Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    answer: { result: Res; dropped: number; outputs: Walked['outputs'] },
    record: ReturnType<typeof recorder>,
  ) => {
    const usage = payload.usage?.(answer.result);
    const { dropped, outputs } = answer;
    const mediaBytes = outputs.reduce((sum, o) => sum + o.body.byteLength, 0);
    const refused = oversized(outputs);
    let outcome: GateRecord['outcome'] = refused ? 'refused' : 'ok';
    try {
      if (usage) {
        await ctx.meter(usage, target.model);
        await outside(ctx)?.meter(ctx, usage, target.model);
      }
      if (refused) {
        const message = `the answer was refused: ${refused}`;
        throw target.refuse?.('media', message) ?? new GateError('media', message);
      }
      if (outputs.length > 0)
        await keep(ctx, outputs).catch((error: unknown) => {
          outcome = 'failed';
          throw error;
        });
      const provenance = payload.provenance?.(answer.result);
      if (provenance) await ctx.provenance?.(provenance);
    } finally {
      await record(outcome, {
        ...(refused ? { refusal: 'media' as const } : {}),
        ...(usage ? { usage } : {}),
        ...(dropped ? { dropped } : {}),
        ...(outputs.length ? { mediaBytes } : {}),
      });
    }
  };

  const call = async <Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    request: Req,
    send: (request: Req) => Promise<Res>,
  ): Promise<Res> => {
    const noted: Pick<GateRecord, 'mediaInput'> = {};
    const record = recorder(ctx, target, noted);
    const guard = await open(ctx, target, payload, request, record);
    noted.mediaInput = guard.mediaInput;
    const raw = await send(guard.body).catch(async (error: unknown) => {
      await record('failed');
      throw error;
    });
    const answer = await received(payload, raw, record);
    await settle(ctx, target, payload, answer, record);
    return guard.finish(answer.result);
  };

  const event = (chunk: unknown): GateChunk<unknown> & { extra: number } => {
    const { kind, text, result, ...rest } = (chunk ?? {}) as Record<string, unknown>;
    const extra = Object.values(rest).filter((v) => v !== undefined).length;
    if (kind === 'delta' && typeof text === 'string') return { kind, text, extra };
    if (kind === 'done' && result !== undefined) return { kind, result, extra };
    throw new ShapeError(`the stream sent an event outside its shape (${String(kind)})`);
  };

  async function* stream<Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    request: Req,
    send: (request: Req) => AsyncIterable<GateChunk<Res>>,
  ): AsyncIterable<GateChunk<Res>> {
    const noted: Pick<GateRecord, 'mediaInput'> = {};
    const record = recorder(ctx, target, noted);
    const guard = await open(ctx, target, payload, request, record);
    noted.mediaInput = guard.mediaInput;
    let carry = '';
    const release = function* (text: string): Generator<GateChunk<Res>> {
      if (!guard.restores) {
        if (text) yield { kind: 'delta', text };
        return;
      }
      const all = carry + text;
      const keep = Math.min(guard.pending(all), all.length);
      carry = all.slice(all.length - keep);
      const ready = all.slice(0, all.length - keep);
      if (ready) yield { kind: 'delta', text: guard.restore(ready) };
    };
    const held: string[] = [];
    let ended: { result: unknown } | undefined;
    let extra = 0;
    try {
      for await (const chunk of send(guard.body)) {
        const seen = event(chunk);
        extra += seen.extra;
        if (seen.kind === 'done') ended = { result: seen.result };
        else if (guard.holds) held.push(seen.text);
        else yield* release(seen.text);
      }
      if (!ended) throw new Error('the stream ended without a result');
    } catch (error) {
      await record('failed');
      throw error;
    }
    const answer = await received(payload, ended.result, record);
    await settle(ctx, target, payload, { ...answer, dropped: answer.dropped + extra }, record);
    const finished = await guard.finish(answer.result);
    for (const text of held) yield* release(text);
    if (carry) yield { kind: 'delta', text: guard.restore(carry) };
    yield { kind: 'done', result: finished };
  }

  const textAt = (value: unknown, path: readonly string[]): string | undefined => {
    let at = value;
    for (const key of path) {
      if (typeof at !== 'object' || at === null) return undefined;
      at = (at as Record<string, unknown>)[key];
    }
    return typeof at === 'string' ? at : undefined;
  };

  const withText = (value: unknown, path: readonly string[], text: string): unknown => {
    const [key, ...rest] = path;
    if (key === undefined) return text;
    if (typeof value !== 'object' || value === null) return value;
    const record = value as Record<string, unknown>;
    return { ...record, [key]: withText(record[key], rest, text) };
  };

  const session = async (
    ctx: PortContext,
    target: GateTarget,
    sessionOptions: GateSessionOptions = {},
  ): Promise<GateSession> => {
    const noted: Pick<GateRecord, 'mediaInput'> = { mediaInput: [] };
    const record = recorder(ctx, target, noted);
    const guards = distinct(ctx.guards ?? []);
    try {
      admit(ctx, target);
      if (sessionOptions.binaryOut && !options.media?.allows(sessionOptions.binaryOut))
        throw new GateError(
          'media',
          `this environment keeps no ${sessionOptions.binaryOut} output; an operator allows the media type first`,
        );
      if (guards.some((g) => g.holdsStream))
        throw new GateError(
          'shape',
          'a live session streams as it goes, so a guard that must see the whole answer first cannot be used',
        );
    } catch (error) {
      if (!(error instanceof GateError)) {
        await record('refused', { refusal: 'guard' });
        throw error;
      }
      await record('refused', { refusal: error.refusal });
      throw target.refuse?.(error.refusal, error.message) ?? error;
    }
    const maskers = distinct(guards.flatMap((g) => (g.masker ? [g.masker] : [])));
    const restoring = maskers.filter((m) => m.unmask);
    const restore = (text: string) =>
      restoring.reduceRight((t, m) => (m.unmask ? m.unmask(t) : t), text);
    const call: GateCall = {
      port: target.port,
      operation: target.operation,
      model: target.model.id,
    };
    let usage: Usage = {};
    let mediaBytes = 0;
    let carry = '';
    const refuse = (error: GateError) => target.refuse?.(error.refusal, error.message) ?? error;
    return {
      outbound: async (shape, message) => {
        const checked = walk(shape, message, { side: 'request' });
        if (checked.media.length > 0 || checked.problems.length > 0)
          throw refuse(
            new GateError(
              checked.media.length > 0 ? 'media' : 'shape',
              `the message is outside its shape: ${[...checked.problems, ...checked.media].join('; ')}`,
            ),
          );
        const masked = walk(shape, message, {
          side: 'request',
          map: (text) => maskers.reduce((t, m) => m.mask(t), text),
        });
        let body: unknown = masked.value;
        for (const guard of guards) if (guard.request) body = await guard.request(call, body);
        const final = walk(shape, body, { side: 'request' });
        if (final.problems.length > 0)
          throw refuse(
            new GateError(
              'shape',
              `the message is outside its shape: ${final.problems.join('; ')}`,
            ),
          );
        return final.value;
      },
      outboundBinary: async (path, type, bytes) => {
        try {
          consented(ctx, target, [{ path, type, value: bytes }] as MediaInputFound[]);
        } catch (error) {
          if (error instanceof GateError) throw refuse(error);
          throw error;
        }
        const cap = options.media?.maxBytes(type) ?? defaultMediaOutputMaxBytes;
        if (bytes.byteLength > cap)
          throw refuse(
            new GateError(
              'media',
              `${path}: ${bytes.byteLength} bytes of ${type} is over the cap of ${cap} bytes`,
            ),
          );
        noted.mediaInput?.push({
          path,
          mediaType: type,
          bytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        });
        return bytes;
      },
      inbound: (shape, message, hold) => {
        let value = message;
        if (hold && restoring.length > 0) {
          const text = textAt(message, hold);
          if (text !== undefined) {
            const all = carry + text;
            const keep = Math.min(
              Math.max(0, ...restoring.map((m) => m.pending?.(all) ?? 0)),
              all.length,
            );
            carry = all.slice(all.length - keep);
            value = withText(message, hold, restore(all.slice(0, all.length - keep)));
          }
        }
        const walked = walk(shape, value, {
          side: 'result',
          ...(restoring.length > 0 ? { map: restore } : {}),
        });
        if (walked.problems.length > 0)
          throw new ShapeError(
            `the provider sent a message outside its shape: ${walked.problems.join('; ')}`,
          );
        return walked.value;
      },
      inboundBinary: (type, bytes) => {
        if (!options.media?.allows(type))
          throw refuse(new GateError('media', `this environment keeps no ${type} output`));
        const cap = options.media.maxBytes(type);
        if (bytes.byteLength > cap)
          throw refuse(
            new GateError(
              'media',
              `${bytes.byteLength} bytes of ${type} is over the cap of ${cap} bytes`,
            ),
          );
        mediaBytes += bytes.byteLength;
      },
      flush: () => {
        const rest = restoring.length > 0 ? restore(carry) : carry;
        carry = '';
        return rest;
      },
      stillAdmitted: (maturity) =>
        maturityAdmits(maturity, options.tier ?? 'production', target.synthetic === true),
      meter: async (more) => {
        usage = addUsage(usage, more);
        await ctx.meter(more, target.model);
        await outside(ctx)?.meter(ctx, more, target.model);
      },
      end: async (outcome) => {
        await record(outcome, {
          ...(Object.keys(usage).length > 0 ? { usage } : {}),
          ...(mediaBytes > 0 ? { mediaBytes } : {}),
        });
      },
    };
  };

  const egress = (endpoint: string): typeof fetch => {
    const guarded: typeof fetch = (input, init) =>
      (options.egress?.(endpoint) ?? globalThis.fetch)(input, init);
    return guarded;
  };

  return { egress, call, stream, session };
};
