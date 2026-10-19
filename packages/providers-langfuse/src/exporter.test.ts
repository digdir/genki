import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { textPart, type Event, type Principal, type Task } from '@genai/contracts';
import {
  createKernel,
  envSecrets,
  InMemoryEventLog,
  InMemoryTaskStore,
  type Capability,
  type PortContext,
} from '@genai/kernel';
import {
  createTraceExporter,
  observedEventLog,
  type ExporterConfigInput,
  type OtlpSpan,
  type TraceOutput,
} from './index.js';

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  spans: OtlpSpan[];
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const collector = async (status: (attempt: number) => number = () => 200) => {
  const received: Received[] = [];
  let attempts = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      attempts += 1;
      const code = status(attempts);
      if (code === 200) {
        const body = JSON.parse(raw) as {
          resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
        };
        received.push({
          path: req.url ?? '',
          headers: req.headers,
          raw,
          spans: body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
        });
      }
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public/otel`,
    received,
    attempts: () => attempts,
  };
};

const attr = (span: OtlpSpan | undefined, key: string) => {
  const value = span?.attributes.find((a) => a.key === key)?.value;
  if (!value) return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('boolValue' in value) return value.boolValue;
  if ('doubleValue' in value) return value.doubleValue;
  return value.arrayValue.values.map((v) => ('stringValue' in v ? v.stringValue : ''));
};

const personalNumber = '01017012345';
const secretAnswer = 'Hemmelig svar om saken';
const secretSource = 'Hemmelig kildetekst om saken';
const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari-nordmann',
  tenant: '999888777',
};

const descriptor = (id: string) => ({
  id,
  version: '3',
  tenant: '999888777',
  title: id,
  description: id,
  input: {},
  interaction: ['unary' as const],
  accepts: [],
  produces: [],
  emits: [],
  oversight: { interrupts: false, riskClass: 'minimal' as const, aiDisclosure: 'KI' },
});

const model = { kind: 'model', id: 'foundry/gpt-4o', tenant: '999888777' };

const run = async (config: Omit<ExporterConfigInput, 'endpoint'>, url: string, fail = false) => {
  const tasks = new InMemoryTaskStore();
  const exporter = createTraceExporter(
    { endpoint: url, ...config },
    {
      secrets: envSecrets({ LANGFUSE_SECRET: 'sk-lf-test', PSEUDONYM_KEY: 'pepper' }),
      tasks: async (id) => (await tasks.get(id))?.task,
    },
  );
  const capabilities: Capability[] = [
    {
      descriptor: descriptor('kunnskapsassistenten'),
      strategy: { id: 'ask', version: '1' },
      config: {},
      grants: [{ port: 'model', ref: model }],
    },
    {
      descriptor: descriptor('oppslag'),
      strategy: { id: 'lookup', version: '1' },
      config: {},
      grants: [],
    },
  ];
  const kernel = createKernel({
    strategies: [
      {
        id: 'ask',
        version: '1',
        requires: { kernel: 1, ports: ['model'], features: ['subinvoke'] },
        run: async function* (ctx, input) {
          yield {
            type: 'kernel.notice',
            data: { text: `Søker etter ${personalNumber}` },
            span: { id: 'retrieve' },
          };
          const port = await ctx.use<{ chat(): Promise<string> }>('model', model);
          const answer = await port.chat();
          const child = await ctx.invoke('oppslag', input);
          await child.result;
          if (fail) throw new Error(`failed on ${personalNumber}`);
          yield { type: 'kernel.part', data: textPart(answer), span: { id: 'answer' } };
          yield {
            type: 'kernel.result',
            data: [
              { ...textPart(`${answer} [1]`), meta: { citations: [{ index: 1, chunkId: 'c1' }] } },
              {
                mime: 'application/vnd.genai.sources+json',
                body: {
                  kind: 'json',
                  json: {
                    sources: [
                      {
                        chunkId: 'c1',
                        title: 'Årsrapport 2023',
                        headers: ['Årsrapport 2023', 'Likelønn'],
                        url: 'https://kudos.dfo.no/dokument/d1',
                        document: 'd1',
                        publishedAt: '2024-04-15',
                        text: secretSource,
                      },
                    ],
                  },
                },
              },
            ],
          };
        },
      },
      {
        id: 'lookup',
        version: '1',
        requires: { kernel: 1, ports: [], features: [] },
        run: async function* () {
          yield { type: 'kernel.result', data: [textPart('oppslag ferdig')] };
        },
      },
    ],
    capabilities,
    ports: {
      model: {
        open: (_ref, ctx: PortContext) => ({
          chat: async () => {
            await ctx.meter(
              { inputTokens: 120, outputTokens: 30, requests: 1, costMicroNok: 2500 },
              model,
            );
            await ctx.provenance?.({
              model: { id: 'foundry/gpt-4o', endpoint: 'foundry', deployment: 'gpt-4o-2024-08' },
            });
            await ctx.provenance?.({ index: { dataset: 'digdir/kudos', generation: 'g2' } });
            await ctx.provenance?.({
              index: { dataset: 'digdir/ka', collections: ['ka_docs', 'ka_chunks'] },
            });
            return secretAnswer;
          },
        }),
      },
    },
    policy: { decide: async () => ({ allow: true }) },
    log: observedEventLog(new InMemoryEventLog(), exporter),
    tasks,
  });

  const started = await kernel.invoke(kari, 'kunnskapsassistenten', {
    data: { question: personalNumber },
  });
  await started.result.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await exporter.flush();
  return { exporter, task: started.task };
};

describe('trace exporter', () => {
  it('exports a task as a trace with metadata only, including the deployment and index generation it used, and no person, prompt or answer', async () => {
    const { url, received } = await collector();

    const { task } = await run({}, url);

    const raw = received.map((r) => r.raw).join('');
    expect(raw).not.toContain(personalNumber);
    expect(raw).not.toContain(secretAnswer);
    expect(raw).not.toContain(secretSource);
    expect(raw).not.toContain('Årsrapport 2023');
    expect(raw).not.toContain('kari-nordmann');

    const spans = received.flatMap((r) => r.spans);
    const root = spans.find((s) => attr(s, 'genai.task.id') === task);
    expect(root).toMatchObject({ name: 'kunnskapsassistenten', status: { code: 1 } });
    expect(root?.parentSpanId).toBeUndefined();
    expect(attr(root, 'langfuse.trace.name')).toBe('kunnskapsassistenten');
    expect(attr(root, 'genai.tenant')).toBe('999888777');
    expect(attr(root, 'genai.service.version')).toBe('3');
    expect(attr(root, 'genai.strategy.id')).toBe('ask');
    expect(attr(root, 'genai.model.deployments')).toEqual(['foundry/gpt-4o-2024-08']);
    expect(attr(root, 'genai.index.generations')).toEqual([
      'digdir/kudos@g2',
      'digdir/ka (ka_docs, ka_chunks)',
    ]);
    expect(attr(root, 'langfuse.user.id')).toBeUndefined();
    expect(attr(root, 'langfuse.observation.input')).toBeUndefined();
    expect(attr(root, 'langfuse.observation.output')).toBeUndefined();
    expect(attr(root, 'genai.citations')).toBe(1);

    const generation = spans.find((s) => attr(s, 'langfuse.observation.type') === 'generation');
    expect(generation?.parentSpanId).toBe(root?.spanId);
    expect(attr(generation, 'gen_ai.request.model')).toBe('foundry/gpt-4o');
    expect(attr(generation, 'gen_ai.usage.input_tokens')).toBe(120);
    expect(attr(generation, 'gen_ai.usage.output_tokens')).toBe(30);
    expect(attr(generation, 'langfuse.observation.cost_details')).toBe('{"total":0.0025}');

    expect(spans.filter((s) => s.traceId === root?.traceId).map((s) => s.name)).toEqual(
      expect.arrayContaining(['retrieve', 'answer', 'oppslag']),
    );
    const child = spans.find((s) => s.name === 'oppslag');
    expect(child?.parentSpanId).toBe(root?.spanId);
  });

  it('includes the question, the answer and the sources it cites only when the connection opts in to content', async () => {
    const { url, received } = await collector();

    await run({ content: true }, url);

    const root = received.flatMap((r) => r.spans).find((s) => s.name === 'kunnskapsassistenten');
    expect(attr(root, 'langfuse.observation.input')).toContain(personalNumber);
    const output = JSON.parse(String(attr(root, 'langfuse.observation.output'))) as TraceOutput;
    expect(output.answer).toBe(`${secretAnswer} [1]`);
    expect(output.citations).toEqual([
      {
        index: 1,
        title: 'Årsrapport 2023',
        breadcrumb: 'Årsrapport 2023 › Likelønn',
        url: 'https://kudos.dfo.no/dokument/d1',
        document_id: 'd1',
        published_at: '2024-04-15',
        chunk_id: 'c1',
        excerpt: secretSource,
      },
    ]);
  });

  it('authenticates to Langfuse and adds a pseudonymous user id when a pseudonym key is set', async () => {
    const { url, received } = await collector();

    await run(
      {
        auth: {
          kind: 'langfuse',
          publicKey: 'pk-lf-test',
          secretKey: 'secret://env/langfuse-secret',
        },
        pseudonymKey: 'secret://env/pseudonym-key',
        environment: 'test',
      },
      url,
    );

    expect(received[0]?.path).toBe('/api/public/otel/v1/traces');
    expect(received[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`,
    );
    expect(received[0]?.headers['x-langfuse-ingestion-version']).toBe('4');
    const root = received.flatMap((r) => r.spans).find((s) => s.name === 'kunnskapsassistenten');
    expect(attr(root, 'langfuse.user.id')).toMatch(/^[0-9a-f]{32}$/);
    expect(attr(root, 'environment')).toBe('test');
  });

  it('marks a failed task as an error with the code and without the message', async () => {
    const { url, received } = await collector();

    await run({}, url, true);

    const root = received.flatMap((r) => r.spans).find((s) => s.name === 'kunnskapsassistenten');
    expect(root?.status).toEqual({ code: 2, message: 'strategy_error' });
    expect(received.map((r) => r.raw).join('')).not.toContain(personalNumber);
  });

  it('sends nothing for a trace that is sampled out', async () => {
    const { url, received } = await collector();

    const { exporter } = await run({ sampleRate: 0 }, url);

    expect(received).toHaveLength(0);
    expect(exporter.stats().sampledOut).toBe(2);
  });
});

const usageEvents = (task: string, count: number): Event[] => [
  ...Array.from({ length: count }, (_, i) => ({
    type: 'kernel.usage',
    v: 1,
    task,
    seq: i,
    ts: new Date(1_700_000_000_000 + i).toISOString(),
    data: { usage: { inputTokens: 1 }, port: 'model', model: { kind: 'model', id: 'm' } },
    actor: 'kernel' as const,
    audience: 'audit' as const,
  })),
  {
    type: 'kernel.task.status',
    v: 1,
    task,
    seq: count,
    ts: new Date(1_700_000_000_000 + count).toISOString(),
    data: { status: 'completed' },
    actor: 'kernel' as const,
  },
];

const direct = (url: string, config: Omit<ExporterConfigInput, 'endpoint'>) =>
  createTraceExporter(
    { endpoint: url, ...config },
    { secrets: envSecrets({}), tasks: async (): Promise<Task | undefined> => undefined },
  );

const scope = { tenant: '999888777', key: 't' };

describe('export queue', () => {
  it('sends spans in batches of the configured size', async () => {
    const { url, received } = await collector();
    const exporter = direct(url, { batch: { maxSpans: 2, intervalMs: 60_000 } });

    for (const e of usageEvents('t1', 4)) exporter.observe(e, scope);
    await exporter.flush();

    expect(received.map((r) => r.spans.length)).toEqual([2, 2, 1]);
    expect(exporter.stats().exported).toBe(5);
  });

  it('retries a server error with backoff, and gives up on a request the collector rejects', async () => {
    const flaky = await collector((attempt) => (attempt === 1 ? 503 : 200));
    const rejecting = await collector(() => 400);
    const retrying = direct(flaky.url, { batch: { backoffMs: 5 } });
    const refused = direct(rejecting.url, { batch: { backoffMs: 5 } });

    for (const e of usageEvents('t1', 1)) retrying.observe(e, scope);
    for (const e of usageEvents('t2', 1)) refused.observe(e, scope);
    await Promise.all([retrying.flush(), refused.flush()]);

    expect(flaky.attempts()).toBe(2);
    expect(retrying.stats()).toMatchObject({ exported: 2, failed: 0 });
    expect(rejecting.attempts()).toBe(1);
    expect(refused.stats()).toMatchObject({ exported: 0, failed: 2 });
  });

  it('drops spans and counts them when the queue is full, without throwing', async () => {
    const { url, received } = await collector();
    const exporter = direct(url, { batch: { maxQueue: 3, maxSpans: 100, intervalMs: 60_000 } });

    for (const e of usageEvents('t1', 2)) exporter.observe(e, scope);
    for (const e of usageEvents('t2', 2)) exporter.observe(e, scope);
    await exporter.flush();

    expect(exporter.stats()).toMatchObject({ exported: 3, dropped: 3 });
    expect(received.flatMap((r) => r.spans)).toHaveLength(3);
  });

  it('keeps the kernel unaffected when the collector is unreachable', async () => {
    const exporter = direct('http://127.0.0.1:1/otel', { batch: { maxRetries: 1, backoffMs: 1 } });
    const log = observedEventLog(new InMemoryEventLog(), exporter);

    const appended = await Promise.all(
      usageEvents('t1', 2).map(({ seq: _seq, ...e }) => log.append(e, scope)),
    );
    await exporter.flush();

    expect(appended).toHaveLength(3);
    expect(exporter.stats()).toMatchObject({ exported: 0, failed: 3 });
  });

  it('exports what it has when a task is interrupted, then the rest when it ends', async () => {
    const { url, received } = await collector();
    const exporter = direct(url, {});
    const [first, , done] = usageEvents('t1', 2);
    const interrupted = { ...(done as Event), seq: 1, data: { status: 'interrupted' } };

    exporter.observe(first as Event, scope);
    exporter.observe(interrupted, scope);
    await exporter.flush();
    exporter.observe({ ...(first as Event), seq: 2 }, scope);
    exporter.observe({ ...(done as Event), seq: 3 }, scope);
    await exporter.flush();

    expect(received.map((r) => r.spans.map((s) => attr(s, 'langfuse.observation.type')))).toEqual([
      ['generation'],
      ['agent', 'generation'],
    ]);
  });
});
