import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from '@genai/contracts';
import {
  createGate,
  isMediaRef,
  walk,
  type GateRecord,
  type MediaOutput,
  type PayloadGuard,
  type PortContext,
  type Shape,
} from '@genai/kernel';
import { syntheticNationalId } from '@genai/kernel/gate-contract';
import { z } from 'zod';
import type { Descriptor } from './descriptor.js';
import { describedCall } from './executor.js';
import { evaluate } from './mapping.js';

export const operationContractVersion = 'operation@1';

export interface OperationFixture {
  name: string;
  source?: string;
  deployment: string;
  input: unknown;
  request: { method: string; path: string; query?: Record<string, string>; body: unknown };
  response: { status?: number; body: unknown };
  result: unknown;
  usage: Usage;
  dropped?: number;
}

const count = z.number().int().min(0);

export const OperationFixtureSpec = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  source: z.string().max(500).optional(),
  deployment: z.string().min(1).max(200),
  input: z.unknown(),
  request: z.strictObject({
    method: z.string().min(1).max(10),
    path: z.string().min(1).max(500),
    query: z.record(z.string(), z.string()).optional(),
    body: z.unknown(),
  }),
  response: z.strictObject({
    status: z.number().int().min(100).max(599).optional(),
    body: z.unknown(),
  }),
  result: z.unknown(),
  usage: z.strictObject({
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    cachedInputTokens: count.optional(),
    requests: count.optional(),
  }),
  dropped: count.optional(),
});

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

const wireTextFromInputText = (descriptor: Descriptor, fixture: OperationFixture): string[] => {
  const body = evaluate(descriptor.request.body, {
    input: mark(descriptor.input, fixture.input),
    deployment: fixture.deployment,
  });
  const leaked: string[] = [];
  walk(descriptor.wire.request, body, {
    side: 'request',
    map: (t) => {
      if (t.startsWith(plainProbe)) leaked.push(t.slice(plainProbe.length));
      return t;
    },
  });
  return leaked.map((t) => `a text field on the wire holds a value that is not input text (${t})`);
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

const seed = (s: Shape, v: unknown, every: boolean): unknown => {
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

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

const keptInMemory = () => {
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
    if (isMediaRef(value)) return Buffer.from(bodies.get(value.path) ?? []).toString('base64');
    if (Array.isArray(value)) return value.map(encoded);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encoded(v)]));
    return value;
  };
  return { media, encoded };
};

const run = async (
  descriptor: Descriptor,
  fixture: OperationFixture,
  input: unknown,
  guards: readonly PayloadGuard[] = [],
) => {
  const kept = keptInMemory();
  const sent: Recorded[] = [];
  const audit: GateRecord[] = [];
  const metered: Usage[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    sent.push({
      method: init?.method ?? 'GET',
      path: target.pathname.replace(/^\/base/, ''),
      query: Object.fromEntries(target.searchParams),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body ?? 'null')),
    });
    return new Response(JSON.stringify(fixture.response.body), {
      status: fixture.response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
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
      },
      descriptor,
      endpoint: {
        baseURL: 'https://contract.invalid/base',
        credential: { kind: 'api-key', key: async () => 'contract-key' },
        fetch: fetcher,
      },
      deployment: fixture.deployment,
    },
    input,
  ).then(
    (result) => ({ result: kept.encoded(result) }),
    (error: unknown) => ({ error }),
  );
  return { outcome, sent, audit, metered };
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
  const wire = JSON.stringify(sent.map((r) => r.body));
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
      const request = sent[0];
      if (!request || sent.length !== 1) return [`expected one request, saw ${sent.length}`];
      return [
        ...same('method', request.method, fixture.request.method),
        ...same('path', request.path, fixture.request.path),
        ...same('query', request.query, fixture.request.query ?? {}),
        ...same('body', request.body, fixture.request.body),
        ...(request.headers.authorization === 'Bearer contract-key' ||
        Object.values(request.headers).includes('contract-key')
          ? []
          : ['the endpoint credential was not sent']),
      ];
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
): Promise<OperationCheckResult[]> => {
  if (fixtures.length === 0)
    return [{ check: 'has recorded fixtures', problems: [`${descriptor.id} has no fixtures`] }];
  const results: OperationCheckResult[] = [];
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
