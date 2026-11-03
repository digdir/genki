import type { Principal, Ref, ResourceProvenance, Usage } from '@genai/contracts';
import { walk, type OperationShape } from './payload.js';
import type { PortContext } from './spi.js';

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
}

export const withUse = (given: UseOptions | undefined, own: UseOptions): UseOptions => {
  const guards = [...(given?.guards ?? []), ...(own.guards ?? [])];
  const serviceResidency = narrowerResidency(given?.serviceResidency, own.serviceResidency);
  return {
    ...(guards.length > 0 ? { guards } : {}),
    ...(serviceResidency ? { serviceResidency } : {}),
  };
};

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
  unmaskedInput?: boolean;
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
        `endpoint ${target.endpoint ?? ''} has no processor record, so it cannot carry real data`,
      );
  };

  const inShape = <Req, Res>(
    target: GateTarget,
    payload: GatePayload<Res>,
    body: unknown,
    map?: (text: string) => string,
  ): Req => {
    const walked = walk<Req>(payload.shape.request, body, {
      side: 'request',
      ...(map ? { map } : {}),
    });
    if (walked.media.length > 0 && target.unmaskedInput !== true)
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

  const answered = <Res>(
    payload: GatePayload<Res>,
    result: unknown,
    map?: (text: string) => string,
  ) => {
    const walked = walk<Res>(payload.shape.result, result, {
      side: 'result',
      ...(map ? { map } : {}),
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
    inShape(target, payload, request);
    const guards = distinct(ctx.guards ?? []);
    const maskers = distinct(guards.flatMap((g) => (g.masker ? [g.masker] : [])));
    const call: GateCall = {
      port: target.port,
      operation: target.operation,
      model: target.model.id,
    };
    let body: Req = maskers.length
      ? inShape(target, payload, request, (text) => maskers.reduce((t, m) => m.mask(t), text))
      : request;
    for (const guard of guards) if (guard.request) body = (await guard.request(call, body)) as Req;
    body = inShape(target, payload, body);
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
      finish,
      restore,
      pending,
      holds: guards.some((g) => g.holdsStream),
      restores: restoring.length > 0,
    };
  };

  // Only the kernel's `use` sets audit, so a context without it comes from outside a run.
  const outside = (ctx: PortContext) => (ctx.audit ? undefined : options.outside);

  const recorder = (ctx: PortContext, target: GateTarget) => {
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
      const walked = answered(payload, result);
      return {
        result: walked.value,
        dropped: walked.dropped + (payload.dropped?.(walked.value) ?? 0),
      };
    } catch (error) {
      await record('failed');
      throw error;
    }
  };

  const settle = async <Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    answer: { result: Res; dropped: number },
    record: ReturnType<typeof recorder>,
  ) => {
    const usage = payload.usage?.(answer.result);
    const { dropped } = answer;
    try {
      if (usage) {
        await ctx.meter(usage, target.model);
        await outside(ctx)?.meter(ctx, usage, target.model);
      }
      const provenance = payload.provenance?.(answer.result);
      if (provenance) await ctx.provenance?.(provenance);
    } finally {
      await record('ok', { ...(usage ? { usage } : {}), ...(dropped ? { dropped } : {}) });
    }
  };

  const call = async <Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Res>,
    request: Req,
    send: (request: Req) => Promise<Res>,
  ): Promise<Res> => {
    const record = recorder(ctx, target);
    const guard = await open(ctx, target, payload, request, record);
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
    const record = recorder(ctx, target);
    const guard = await open(ctx, target, payload, request, record);
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

  const egress = (endpoint: string): typeof fetch => {
    const guarded: typeof fetch = (input, init) =>
      (options.egress?.(endpoint) ?? globalThis.fetch)(input, init);
    return guarded;
  };

  return { egress, call, stream };
};
