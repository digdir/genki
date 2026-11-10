import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from '@genai/contracts';
import {
  createGate,
  decodeBase64,
  isInlineMedia,
  isMediaRef,
  mediaInputKind,
  mediaTypesOf,
  walk,
  type GateRecord,
  type LedgerObject,
  type ObjectLedger,
  type MediaOutput,
  type PayloadGuard,
  type PortContext,
  type Shape,
} from '@genai/kernel';
import { syntheticNationalId } from '@genai/kernel/gate-contract';
import { z } from 'zod';
import type { Descriptor, Step } from './descriptor.js';
import { recordedBody } from './encoding.js';
import { describedCall, describedSend, type RecordedRequest } from './executor.js';
import { unwrapped } from './shape.js';
import { sessionChecks, type SessionFixture } from './session-contract.js';
import { sessionOfDescriptor } from './session.js';

export const operationContractVersion = 'operation@1';

export interface FixtureRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body: unknown;
}

export interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** One recorded call: a single request and answer, or every step's in order. */
export interface OperationFixture {
  name: string;
  source?: string;
  deployment: string;
  /** The time a module signs with, when the descriptor has one. */
  at?: string;
  input: unknown;
  request?: FixtureRequest;
  response?: FixtureResponse;
  steps?: { step: string; request: FixtureRequest; response: FixtureResponse }[];
  session?: SessionFixture;
  result: unknown;
  usage: Usage;
  dropped?: number;
}

const count = z.number().nonnegative();

const fixtureRequest = z.strictObject({
  method: z.string().min(1).max(10),
  path: z.string().min(1).max(500),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown(),
});

const fixtureResponse = z.strictObject({
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown(),
});

export const OperationFixtureSpec = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    source: z.string().max(500).optional(),
    deployment: z.string().min(1).max(200),
    at: z.iso.datetime().optional(),
    input: z.unknown(),
    request: fixtureRequest.optional(),
    response: fixtureResponse.optional(),
    steps: z
      .array(
        z.strictObject({
          step: z.string().min(1).max(32),
          request: fixtureRequest,
          response: fixtureResponse,
        }),
      )
      .min(1)
      .max(100)
      .optional(),
    session: z
      .strictObject({
        request: z.strictObject({
          path: z.string().min(1).max(500),
          query: z.record(z.string(), z.string()).optional(),
          headers: z.record(z.string(), z.string()).optional(),
        }),
        messages: z
          .array(
            z.strictObject({
              from: z.enum(['client', 'server']),
              message: z.unknown(),
              binary: z.string().max(1_000_000).optional(),
            }),
          )
          .min(1)
          .max(500),
      })
      .optional(),
    result: z.unknown(),
    usage: z.strictObject({
      inputTokens: count.optional(),
      outputTokens: count.optional(),
      cachedInputTokens: count.optional(),
      audioSeconds: count.optional(),
      images: count.optional(),
      videoSeconds: count.optional(),
      characters: count.optional(),
      requests: count.optional(),
      units: z.record(z.string(), count).optional(),
    }),
    dropped: z.number().int().min(0).optional(),
  })
  .refine(
    (f) =>
      f.session
        ? f.steps === undefined && f.request === undefined && f.response === undefined
        : (f.steps === undefined) === (f.request !== undefined && f.response !== undefined),
    'a fixture records request and response, steps, or a session',
  );

/** The recorded requests and answers of a fixture, in order, with the step each belongs to. */
export const exchangesOf = (descriptor: Descriptor, fixture: OperationFixture) =>
  fixture.steps ??
  (fixture.request && fixture.response
    ? [
        {
          step: descriptor.steps[0]?.name ?? 'call',
          request: fixture.request,
          response: fixture.response,
        },
      ]
    : []);

export interface OperationCheckResult {
  check: string;
  problems: string[];
}

export const fixturesFor = (dir: string, id: string): OperationFixture[] => {
  const folder = join(dir, id);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      name: f.replace(/\.json$/, ''),
      ...(JSON.parse(readFileSync(join(folder, f), 'utf8')) as Omit<OperationFixture, 'name'>),
    }));
};

const plainProbe = '\u2064';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mark = (s: Shape, v: unknown): unknown => {
  switch (s.kind) {
    case 'plain':
    case 'ref':
      return typeof v === 'string' ? plainProbe + v : v;
    case 'optional':
      return mark(s.shape, v);
    case 'object':
      return isRecord(v)
        ? Object.fromEntries(
            Object.entries(v).map(([k, x]) => {
              const field = s.fields[k];
              return [k, field ? mark(field, x) : x];
            }),
          )
        : v;
    case 'array':
      return Array.isArray(v) ? v.map((x) => mark(s.item, x)) : v;
    case 'variant': {
      const tag = isRecord(v) ? v[s.key] : undefined;
      const option = typeof tag === 'string' ? s.options[tag] : undefined;
      return option ? mark(option, v) : v;
    }
    case 'either': {
      const fit = s.options.find((o) => {
        const w = walk(o, v, { side: 'request' });
        return w.problems.length === 0 && w.media.length === 0;
      });
      return fit ? mark(fit, v) : v;
    }
    default:
      return v;
  }
};

const wireTextFromInputText = async (
  descriptor: Descriptor,
  fixture: OperationFixture,
): Promise<string[]> => {
  const leaked: string[] = [];
  const recorded = exchangesOf(descriptor, fixture);
  const allSteps = [...descriptor.steps, ...descriptor.finally];
  let at = 0;
  await describedSend(
    descriptor,
    {
      baseURL: 'https://contract.invalid/base',
      credential: { kind: 'api-key', key: async () => contractKey },
      ledger: memoryLedger().ledger,
      ...moduleEndpoint(fixture),
      fetch: async () => {
        const answer = recorded[at];
        at += 1;
        return answer
          ? replayed(
              allSteps.find((s) => s.name === answer.step),
              answer.response,
            )
          : Response.json({}, { status: 500 });
      },
      sleep: async () => undefined,
    },
    fixture.deployment,
    admitted(descriptor.input, mark(descriptor.input, fixture.input)),
    {
      inspect: (shape, value) =>
        walk(shape, value, {
          side: 'request',
          map: (t) => {
            if (t.startsWith(plainProbe)) leaked.push(t.slice(plainProbe.length));
            return t;
          },
        }),
    },
  ).catch(() => undefined);
  return leaked.map((t) => `a text field on the wire holds a value that is not input text (${t})`);
};

/** Media in a fixture input as the gate hands it on once admitted, for checks that run without the gate. */
const admitted = (shape: Shape, input: unknown): unknown => {
  const types = new Map(
    walk(shape, input, { side: 'request' }).inputs.map((i) => [i.value, i.type]),
  );
  return walk(shape, input, {
    side: 'request',
    mapMedia: (v) => {
      const inline = isInlineMedia(v) ? v : undefined;
      const body =
        decodeBase64(inline ? inline.data : typeof v === 'string' ? v : '') ?? new Uint8Array();
      const mediaType = types.get(v) ?? '';
      return { kind: mediaInputKind, mediaType, bytes: body.byteLength, sha256: '', body };
    },
  }).value;
};

const personalData = [syntheticNationalId, 'kari.nordmann@example.no', '+47 912 34 567'];

const masked = '\u00abMASKED\u00bb';

const maskPersonalData: PayloadGuard = {
  masker: { mask: (t) => personalData.reduce((out, value) => out.replaceAll(value, masked), t) },
};

const free = (s: Shape, every: boolean): boolean =>
  s.kind === 'optional'
    ? free(s.shape, every)
    : s.kind === 'text' || (every && (s.kind === 'plain' || s.kind === 'ref'));

const seededJson = (v: unknown): unknown => {
  if (typeof v === 'string') return `${v} ${personalData.join(' ')}`;
  if (Array.isArray(v)) return v.map(seededJson);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, seededJson(x)]));
  return v;
};

const seed = (s: Shape, v: unknown, every: boolean): unknown => {
  if (s.kind === 'json') return seededJson(v);
  if (free(s, every) && typeof v === 'string') {
    const seeded = `${v} ${personalData.join(' ')}`;
    return walk(s, seeded, { side: 'request' }).problems.length === 0 ? seeded : v;
  }
  switch (s.kind) {
    case 'optional':
      return seed(s.shape, v, every);
    case 'object': {
      if (!isRecord(v)) return v;
      const absent = Object.keys(s.fields).filter((k) => v[k] === undefined);
      return Object.fromEntries([
        ...Object.entries(v).map(([k, x]) => {
          const field = s.fields[k];
          return [k, field ? seed(field, x, every) : x];
        }),
        ...absent.flatMap((k) => {
          const field = s.fields[k] as Shape;
          const value = personalData.join(' ');
          return free(field, every) && walk(field, value, { side: 'request' }).problems.length === 0
            ? [[k, value]]
            : [];
        }),
      ]);
    }
    case 'array':
      return Array.isArray(v) ? v.map((x) => seed(s.item, x, every)) : v;
    case 'variant': {
      const tag = isRecord(v) ? v[s.key] : undefined;
      const option = typeof tag === 'string' ? s.options[tag] : undefined;
      return option ? seed(option, v, every) : v;
    }
    case 'either': {
      const fit = s.options.find((o) => {
        const w = walk(o, v, { side: 'request' });
        return w.problems.length === 0 && w.media.length === 0;
      });
      return fit ? seed(fit, v, every) : v;
    }
    default:
      return v;
  }
};

interface Recorded extends RecordedRequest {
  query: Record<string, string>;
  credentialSent: boolean;
  signingKeySent: boolean;
}

const contractKey = 'contract-key';

const defaultContentType = (step: Step | undefined) => {
  const stream = step?.response.stream;
  if (stream)
    return stream.framing === 'sse'
      ? 'text/event-stream'
      : stream.framing === 'ndjson'
        ? 'application/x-ndjson'
        : 'text/plain; charset=utf-8';
  switch (step?.response.encoding) {
    case 'binary':
      return (unwrapped(step.wire.response) as { type: string }).type;
    case 'text':
      return 'text/plain; charset=utf-8';
    case 'ndjson':
      return 'application/x-ndjson';
    default:
      return 'application/json';
  }
};

const typedBytes = (body: unknown) =>
  isRecord(body) && typeof body.mediaType === 'string' && typeof body.data === 'string'
    ? { type: body.mediaType, bytes: Buffer.from(body.data, 'base64') }
    : undefined;

const replayed = (step: Step | undefined, response: FixtureResponse) => {
  const typed = step?.response.encoding === 'binary' ? typedBytes(response.body) : undefined;
  const headers = {
    'content-type': typed?.type ?? defaultContentType(step),
    ...response.headers,
  };
  const status = response.status ?? 200;
  const stream = step?.response.stream;
  const body =
    status < 300 && stream
      ? (response.body as { event?: string; data: unknown }[])
          .map((frame) => {
            const data = typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data);
            return stream.framing === 'sse'
              ? `${frame.event ? `event: ${frame.event}\n` : ''}data: ${data}\n\n`
              : `${data}\n`;
          })
          .join('')
      : status < 300 && step?.response.encoding === 'binary'
        ? (typed?.bytes ?? Buffer.from(String(response.body), 'base64'))
        : status < 300 && step?.response.encoding === 'text'
          ? String(response.body)
          : status < 300 && step?.response.encoding === 'ndjson'
            ? (response.body as unknown[]).map((l) => `${JSON.stringify(l)}\n`).join('')
            : JSON.stringify(response.body);
  return new Response(body, { status, headers });
};

/** A ledger that keeps what a call issues, so a check can see that nothing is left at the provider. */
export const memoryLedger = () => {
  const open = new Map<string, LedgerObject>();
  const all: LedgerObject[] = [];
  const ledger: ObjectLedger = {
    created: async (o) => {
      open.set(o.objectId, o);
      all.push(o);
    },
    deleted: async (k) => {
      open.delete(k.objectId);
    },
  };
  return { ledger, open, all };
};

const keptInMemory = (typed: boolean) => {
  const bodies = new Map<string, Uint8Array>();
  const media: MediaOutput = {
    allows: () => true,
    maxBytes: () => Number.MAX_SAFE_INTEGER,
    keep: async (ctx, body) => {
      const path = `contract/${bodies.size + 1}`;
      bodies.set(path, body);
      return { tenant: ctx.tenant, path, sha256: createHash('sha256').update(body).digest('hex') };
    },
  };
  const encoded = (value: unknown): unknown => {
    if (isMediaRef(value)) {
      const data = Buffer.from(bodies.get(value.path) ?? []).toString('base64');
      return typed ? { mediaType: value.mediaType, data } : data;
    }
    if (Array.isArray(value)) return value.map(encoded);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encoded(v)]));
    return value;
  };
  return { media, encoded };
};

type ModuleLookup = (sha256: string) => Uint8Array | undefined;

const contractModules = new AsyncLocalStorage<ModuleLookup | undefined>();

const moduleEndpoint = (fixture: OperationFixture) => {
  const modules = contractModules.getStore();
  return {
    ...(modules ? { modules } : {}),
    ...(fixture.at ? { now: () => new Date(fixture.at as string) } : {}),
  };
};

const run = async (
  descriptor: Descriptor,
  fixture: OperationFixture,
  input: unknown,
  guards: readonly PayloadGuard[] = [],
  inspect?: (shape: Shape, value: unknown) => void,
) => {
  const kept = keptInMemory(mediaTypesOf(descriptor.output).length > 1);
  const objects = memoryLedger();
  const sent: Recorded[] = [];
  const audit: GateRecord[] = [];
  const metered: Usage[] = [];
  const recorded = exchangesOf(descriptor, fixture);
  const allSteps = [...descriptor.steps, ...descriptor.finally];
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const headers = Object.fromEntries(new Headers(init?.headers));
    const sentQuery = Object.fromEntries(target.searchParams);
    const at = sent.length;
    const step = allSteps.find((s) => s.name === recorded[at]?.step);
    const secret = step?.auth;
    const placement = step?.credential;
    const basic = `Basic ${Buffer.from(`${placement?.place === 'basic' ? placement.username : ''}:${contractKey}`).toString('base64')}`;
    const recordedBodyOf = await recordedBody(init?.body, headers['content-type'] ?? null);
    const formField = placement?.place === 'form' && !secret ? placement.name : undefined;
    const body =
      formField && isRecord(recordedBodyOf)
        ? Object.fromEntries(Object.entries(recordedBodyOf).filter(([k]) => k !== formField))
        : recordedBodyOf;
    const keySent =
      Object.values(headers).some((v) => v.includes(contractKey)) ||
      Object.values(sentQuery).includes(contractKey);
    const signingKeySent = !secret && placement?.place === 'module' && keySent;
    const credentialSent = secret
      ? secret.place === 'query'
        ? secret.name in sentQuery
        : secret.name in headers
      : formField
        ? isRecord(recordedBodyOf) && recordedBodyOf[formField] === contractKey
        : placement?.place === 'basic'
          ? headers.authorization === basic
          : placement?.place === 'module' || keySent;
    const query = Object.fromEntries(
      Object.entries(sentQuery).filter(
        ([name, value]) =>
          value !== contractKey && !(secret?.place === 'query' && name === secret.name),
      ),
    );
    const mapped = Object.keys(step?.request.headers ?? {}).map((h) => h.toLowerCase());
    sent.push({
      method: init?.method ?? 'GET',
      path: step?.request.follow
        ? `${target.host}${target.pathname}`
        : target.pathname.replace(/^\/base/, ''),
      query,
      headers: Object.fromEntries(Object.entries(headers).filter(([h]) => mapped.includes(h))),
      body,
      credentialSent,
      signingKeySent,
    });
    const answer = recorded[at]?.response;
    if (!answer)
      return Response.json({ error: { message: 'no recorded answer' } }, { status: 500 });
    return replayed(step, answer);
  };
  const ctx: PortContext = {
    tenant: '999888777',
    principal: { kind: 'operator', issuer: 'test', subject: 'contract' },
    task: 'operation-contract',
    signal: new AbortController().signal,
    meter: async (usage) => {
      metered.push(usage);
    },
    audit: async (record) => {
      audit.push(record);
    },
    ...(guards.length ? { guards } : {}),
  };
  const outcome = await describedCall(
    {
      gate: createGate({ media: kept.media }),
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
        credential: { kind: 'api-key', key: async () => contractKey },
        ledger: objects.ledger,
        ...moduleEndpoint(fixture),
        connection: 'contract',
        tenant: '999888777',
        run: 'operation-contract',
        fetch: fetcher,
        sleep: async () => undefined,
      },
      deployment: fixture.deployment,
      ...(inspect ? { inspect } : {}),
    },
    input,
  ).then(
    (result) => ({ result: kept.encoded(result) }),
    (error: unknown) => ({ error }),
  );
  return { outcome, sent, audit, metered, objects };
};

/** A typed descriptor's plain and ref fields are Genki's own; any other descriptor may only send text. */
const personalDataReachesTheWireMasked = async (
  descriptor: Descriptor,
  fixture: OperationFixture,
): Promise<string[]> => {
  const input = seed(descriptor.input, fixture.input, descriptor.status !== 'typed');
  const { sent, outcome } = await run(descriptor, fixture, input, [maskPersonalData]);
  if ('error' in outcome && sent.length === 0)
    return [`the call with personal data in its input failed: ${String(outcome.error)}`];
  const wire = JSON.stringify(sent.map((r) => [r.body, r.query, r.headers]));
  return personalData
    .filter((value) => wire.includes(value))
    .map((value) => `${value} reached the wire unmasked`);
};

const same = (label: string, actual: unknown, expected: unknown) =>
  isDeepStrictEqual(actual, expected)
    ? []
    : [`${label} differs: got ${JSON.stringify(actual)}, recorded ${JSON.stringify(expected)}`];

const outsideShape = (input: unknown) =>
  Array.isArray(input) ? [...input, 42] : { ...(input as object), unrecorded_field: true };

const checks: {
  name: string;
  run(descriptor: Descriptor, fixture: OperationFixture): Promise<string[]> | string[];
}[] = [
  {
    name: 'the request built from the typed input is the recorded wire request',
    run: async (descriptor, fixture) => {
      const { sent, outcome } = await run(descriptor, fixture, fixture.input);
      if ('error' in outcome) return [`the call failed: ${String(outcome.error)}`];
      const recorded = exchangesOf(descriptor, fixture);
      if (sent.length !== recorded.length)
        return [`expected ${recorded.length} requests, saw ${sent.length}`];
      return sent.flatMap((request, i) => {
        const want = (recorded[i] as { request: FixtureRequest }).request;
        const at = recorded.length > 1 ? `request ${i + 1}: ` : '';
        return [
          ...same(`${at}method`, request.method, want.method),
          ...same(`${at}path`, request.path, want.path),
          ...same(`${at}query`, request.query, want.query ?? {}),
          ...same(`${at}headers`, request.headers, want.headers ?? {}),
          ...same(`${at}body`, request.body, want.body),
          ...(request.credentialSent ? [] : [`${at}the endpoint credential was not sent`]),
          ...(request.signingKeySent ? [`${at}the key that only signs was sent`] : []),
        ];
      });
    },
  },
  {
    name: 'the recorded response maps to the typed result',
    run: async (descriptor, fixture) => {
      const { outcome } = await run(descriptor, fixture, fixture.input);
      if ('error' in outcome) return [`the call failed: ${String(outcome.error)}`];
      return same('result', outcome.result, fixture.result);
    },
  },
  {
    name: 'usage is mapped and metered',
    run: async (descriptor, fixture) => {
      const { metered, audit } = await run(descriptor, fixture, fixture.input);
      return [
        ...same('metered usage', metered, [fixture.usage]),
        ...same('audited usage', audit[0]?.usage, fixture.usage),
      ];
    },
  },
  {
    name: 'unknown response fields are dropped and counted',
    run: async (descriptor, fixture) => {
      const { audit } = await run(descriptor, fixture, fixture.input);
      return same('dropped', audit[0]?.dropped ?? 0, fixture.dropped ?? 0);
    },
  },
  {
    name: 'an input outside the typed shape is refused before anything leaves',
    run: async (descriptor, fixture) => {
      const { sent, outcome, audit } = await run(descriptor, fixture, outsideShape(fixture.input));
      return [
        ...('error' in outcome ? [] : ['the call was not refused']),
        ...(sent.length === 0 ? [] : ['a request left']),
        ...same('refusal', audit[0]?.refusal, 'shape'),
      ];
    },
  },
  {
    name: 'every object the call keeps at the provider is in the ledger and deleted by the call',
    run: async (descriptor, fixture) => {
      if (descriptor.resources.length === 0) return [];
      const { objects, outcome } = await run(descriptor, fixture, fixture.input);
      if ('error' in outcome) return [`the call failed: ${String(outcome.error)}`];
      const left = [...objects.open.values()].filter((o) => o.deletable);
      return [
        ...(objects.all.length === 0 ? ['the call recorded no object in the ledger'] : []),
        ...left.map((o) => `${o.step}.${o.field} ${o.objectId} was left at the provider`),
      ];
    },
  },
  {
    name: 'only input text reaches a text field on the wire',
    run: wireTextFromInputText,
  },
  {
    name: 'a national id, an email and a phone number in any input string reach the wire masked',
    run: personalDataReachesTheWireMasked,
  },
];

/** The `operation@1` suite: proves one descriptor against its recorded fixtures. */
export const operationContract = async (
  descriptor: Descriptor,
  fixtures: readonly OperationFixture[],
  options: { modules?: (sha256: string) => Uint8Array | undefined } = {},
): Promise<OperationCheckResult[]> =>
  contractModules.run(options.modules, () => runContract(descriptor, fixtures));

const runContract = async (
  descriptor: Descriptor,
  fixtures: readonly OperationFixture[],
): Promise<OperationCheckResult[]> => {
  if (fixtures.length === 0)
    return [{ check: 'has recorded fixtures', problems: [`${descriptor.id} has no fixtures`] }];
  const results: OperationCheckResult[] = [];
  if (sessionOfDescriptor(descriptor)) {
    for (const fixture of fixtures)
      for (const check of sessionChecks(contractKey))
        results.push({
          check: `${fixture.name}: ${check.name}`,
          problems: fixture.session
            ? await check.run(descriptor, { ...fixture, session: fixture.session })
            : [`${descriptor.id} is a session, so its fixture records a session`],
        });
    return results;
  }
  for (const fixture of fixtures)
    for (const check of checks)
      results.push({
        check: `${fixture.name}: ${check.name}`,
        problems: await check.run(descriptor, fixture),
      });
  return results;
};

export const contractFailures = (results: readonly OperationCheckResult[]) =>
  results.filter((r) => r.problems.length > 0);
