import type { Principal, Ref, ResourceProvenance, Usage } from '@genai/contracts';
import type { PortContext } from './spi.js';

export const residencies = ['norway', 'eu', 'global'] as const;
export type Residency = (typeof residencies)[number];

export const residencyAllows = (allowed: Residency, actual: Residency) =>
  residencies.indexOf(actual) <= residencies.indexOf(allowed);

export const narrowerResidency = (a: Residency | undefined, b: Residency | undefined) =>
  a === undefined ? b : b === undefined ? a : residencyAllows(a, b) ? b : a;

export type Admission = 'admitted' | 'open';

export type GateRefusal = 'admission' | 'disabled' | 'not-shared' | 'residency' | 'media' | 'shape';

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
  residency: Residency;
  admission: Admission;
  enabled?: boolean;
  tenants?: readonly string[];
  tenant?: string;
  routerResidency?: Residency;
  requestResidency?: Residency;
  refuse?: (refusal: GateRefusal, message: string) => Error;
}

export interface GatePayload<Req, Res> {
  contents(request: Req): readonly unknown[];
  mapRequest(request: Req, map: (text: string) => string): Req;
  mapResult(result: Res, map: (text: string) => string): Res;
  usage?(result: Res): Usage | undefined;
  provenance?(result: Res): ResourceProvenance | undefined;
  /** Names what in a request falls outside the operation's closed shape. */
  check?(request: Req): string | undefined;
  dropped?(result: Res): number | undefined;
}

export type GateChunk<Res> = { kind: 'delta'; text: string } | { kind: 'done'; result: Res };

export interface GateOptions {
  admits?: (principal: Principal) => boolean;
}

export interface Gate {
  call<Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Req, Res>,
    request: Req,
    send: (request: Req) => Promise<Res>,
  ): Promise<Res>;
  stream<Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Req, Res>,
    request: Req,
    send: (request: Req) => AsyncIterable<GateChunk<Res>>,
  ): AsyncIterable<GateChunk<Res>>;
}

const distinct = <T>(items: readonly T[]) => [...new Set(items)];

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
  };

  const guarded = async <Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Req, Res>,
    request: Req,
  ) => {
    if (payload.contents(request).some((c) => typeof c !== 'string'))
      throw new GateError(
        'media',
        'the payload has image, audio or file content, which cannot be masked',
      );
    const outside = (body: Req) => {
      const problem = payload.check?.(body);
      if (problem) throw new GateError('shape', problem);
    };
    outside(request);
    const guards = distinct(ctx.guards ?? []);
    const maskers = distinct(guards.flatMap((g) => (g.masker ? [g.masker] : [])));
    const call: GateCall = {
      port: target.port,
      operation: target.operation,
      model: target.model.id,
    };
    let body = maskers.length
      ? payload.mapRequest(request, (text) => maskers.reduce((t, m) => m.mask(t), text))
      : request;
    for (const guard of guards) if (guard.request) body = (await guard.request(call, body)) as Req;
    outside(body);
    const restoring = maskers.filter((m) => m.unmask);
    const restore = (text: string) =>
      restoring.reduceRight((t, m) => (m.unmask ? m.unmask(t) : t), text);
    const finish = async (result: Res) => {
      for (const guard of [...guards].reverse()) if (guard.result) await guard.result(call, result);
      return restoring.length ? payload.mapResult(result, restore) : result;
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

  const recorder = (ctx: PortContext, target: GateTarget) => {
    let written = false;
    return async (
      outcome: GateRecord['outcome'],
      extra: Pick<GateRecord, 'refusal' | 'usage' | 'dropped'> = {},
    ) => {
      if (written) return;
      written = true;
      await ctx.audit?.({
        port: target.port,
        operation: target.operation,
        model: target.model.id,
        ...(target.endpoint ? { endpoint: target.endpoint } : {}),
        residency: target.residency,
        outcome,
        ...extra,
      });
    };
  };

  const open = async <Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Req, Res>,
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

  const settle = async <Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Req, Res>,
    result: Res,
    record: ReturnType<typeof recorder>,
  ) => {
    const usage = payload.usage?.(result);
    const dropped = payload.dropped?.(result);
    try {
      if (usage) await ctx.meter(usage, target.model);
      const provenance = payload.provenance?.(result);
      if (provenance) await ctx.provenance?.(provenance);
    } finally {
      await record('ok', { ...(usage ? { usage } : {}), ...(dropped ? { dropped } : {}) });
    }
  };

  const call = async <Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Req, Res>,
    request: Req,
    send: (request: Req) => Promise<Res>,
  ): Promise<Res> => {
    const record = recorder(ctx, target);
    const guard = await open(ctx, target, payload, request, record);
    const result = await send(guard.body).catch(async (error: unknown) => {
      await record('failed');
      throw error;
    });
    await settle(ctx, target, payload, result, record);
    return guard.finish(result);
  };

  async function* stream<Req, Res>(
    ctx: PortContext,
    target: GateTarget,
    payload: GatePayload<Req, Res>,
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
    let ended: { result: Res } | undefined;
    try {
      for await (const chunk of send(guard.body)) {
        if (chunk.kind === 'done') ended = { result: chunk.result };
        else if (guard.holds) held.push(chunk.text);
        else yield* release(chunk.text);
      }
      if (!ended) throw new Error('the stream ended without a result');
    } catch (error) {
      await record('failed');
      throw error;
    }
    await settle(ctx, target, payload, ended.result, record);
    const finished = await guard.finish(ended.result);
    for (const text of held) yield* release(text);
    if (carry) yield { kind: 'delta', text: guard.restore(carry) };
    yield { kind: 'done', result: finished };
  }

  return { call, stream };
};
