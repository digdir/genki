import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { textPart, type EvaluationContext, type Principal } from '@genai/contracts';
import {
  createKernel,
  envSecrets,
  InMemoryEventLog,
  InMemoryTaskStore,
  type Capability,
  type Strategy,
} from '@genai/kernel';
import {
  createExperimentRouter,
  createTraceExporter,
  observedEventLog,
  type OtlpSpan,
} from './index.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const collector = async () => {
  const spans: OtlpSpan[] = [];
  let raw = '';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      raw += body;
      const parsed = JSON.parse(body) as {
        resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
      };
      spans.push(...parsed.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/public/otel`,
    spans,
    raw: () => raw,
  };
};

const attr = (span: OtlpSpan | undefined, key: string) => {
  const value = span?.attributes.find((a) => a.key === key)?.value;
  return value && 'stringValue' in value ? value.stringValue : undefined;
};

const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '999888777' };

const descriptor = (id: string) => ({
  id,
  version: '1',
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

const evaluation = (run: string, item: string, repeat = 0): EvaluationContext => ({
  run: { id: run, name: `${run} v1` },
  case: { id: item, repeat, split: 'validation' },
  sink: 'etaten',
});

const boot = (
  open: (router: ReturnType<typeof createExperimentRouter>, tasks: InMemoryTaskStore) => void,
) => {
  const tasks = new InMemoryTaskStore();
  const router = createExperimentRouter();
  open(router, tasks);
  const lookup: Strategy = {
    id: 'lookup',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* () {
      yield { type: 'kernel.result', data: [textPart('treff')] };
    },
  };
  const answer: Strategy = {
    id: 'answer',
    version: '1',
    requires: { kernel: 1, ports: [], features: ['subinvoke'] },
    run: async function* (ctx) {
      await (
        await ctx.invoke('lookup', {})
      ).result;
      yield { type: 'kernel.result', data: [textPart('Fristen er 1. mai.')] };
    },
  };
  const evalRun: Strategy = {
    id: 'eval',
    version: '1',
    requires: { kernel: 1, ports: [], features: ['subinvoke'] },
    run: async function* (ctx, input) {
      const items = (input.data as { items: EvaluationContext[] }).items;
      for (const item of items)
        await (
          await ctx.invoke('answer', { parts: [textPart('Når er fristen?')] }, { evaluation: item })
        ).result;
      yield { type: 'kernel.result', data: [] };
    },
  };
  const capability = (id: string): Capability => ({
    descriptor: descriptor(id),
    strategy: { id, version: '1' },
    config: {},
    grants: [],
  });
  const kernel = createKernel({
    strategies: [lookup, answer, evalRun],
    capabilities: [capability('lookup'), capability('answer'), capability('eval')],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
    log: observedEventLog(new InMemoryEventLog(), router),
    tasks,
  });
  return { kernel, router };
};

const exporterFor = (url: string, tasks: InMemoryTaskStore, content = false, experiments = true) =>
  createTraceExporter(
    {
      endpoint: url,
      content,
      auth: { kind: 'langfuse', publicKey: 'pk', secretKey: 'secret://env/sk' },
    },
    {
      secrets: envSecrets({ SK: 'sk' }),
      tasks: async (id) => (await tasks.get(id))?.task,
      experiments,
    },
  );

describe('eval runs as Langfuse experiments', () => {
  it('exports each case as one item of the run, a trace of its own rooted at the case with its sub-tasks', async () => {
    const sink = await collector();
    const { kernel, router } = boot((r, tasks) =>
      r.open('run-1', exporterFor(sink.url, tasks, true)),
    );

    const run = await kernel.invoke(kari, 'eval', {
      data: { items: [evaluation('run-1', 'o1', 0), evaluation('run-1', 'o1', 1)] },
    });
    await run.result;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await router.close('run-1');

    const roots = sink.spans.filter((s) => s.name === 'answer');
    expect(roots.map((s) => attr(s, 'langfuse.experiment.item.id'))).toEqual(['o1#0', 'o1#1']);
    expect(roots.map((s) => s.parentSpanId)).toEqual([undefined, undefined]);
    expect(new Set(roots.map((s) => s.traceId)).size).toBe(2);
    for (const span of sink.spans) {
      expect(attr(span, 'langfuse.experiment.id')).toBe('run-1');
      expect(attr(span, 'langfuse.experiment.name')).toBe('run-1 v1');
    }
    const lookups = sink.spans.filter((s) => s.name === 'lookup');
    expect(lookups.map((s) => s.traceId).sort()).toEqual(roots.map((s) => s.traceId).sort());
    expect(sink.spans.some((s) => s.name === 'eval')).toBe(false);
    expect(attr(roots[0], 'langfuse.experiment.item.metadata.split')).toBe('validation');
    expect(attr(roots[0], 'langfuse.observation.input')).toBe(
      JSON.stringify({ parts: [textPart('Når er fristen?')] }),
    );
    expect(sink.raw()).not.toContain('etaten');
  });

  it("sends each run only to its own sink and tenant, so one tenant's run never reaches another's", async () => {
    const first = await collector();
    const second = await collector();
    const { kernel, router } = boot((r, tasks) => {
      r.open('run-a', exporterFor(first.url, tasks), '999888777');
      // Opened for another tenant: Kari's cases never reach it, whatever run they name.
      r.open('run-b', exporterFor(second.url, tasks), '111222333');
    });

    await (
      await kernel.invoke(kari, 'eval', { data: { items: [evaluation('run-a', 'a1')] } })
    ).result;
    await (
      await kernel.invoke(kari, 'eval', { data: { items: [evaluation('run-b', 'b1')] } })
    ).result;
    await (
      await kernel.invoke(kari, 'eval', { data: { items: [evaluation('run-c', 'c1')] } })
    ).result;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await router.close('run-a');
    await router.close('run-b');

    expect(new Set(first.spans.map((s) => attr(s, 'langfuse.experiment.id')))).toEqual(
      new Set(['run-a']),
    );
    expect(second.spans).toEqual([]);
  });

  it('leaves an eval run as ordinary traces in an exporter that does not export experiments', async () => {
    const sent = async (experiments: boolean) => {
      const sink = await collector();
      const exporter = exporterFor(sink.url, new InMemoryTaskStore(), false, experiments);
      const scope = { tenant: '999888777', key: 'k' };
      const ts = new Date().toISOString();
      exporter.observe(
        {
          type: 'kernel.task.input',
          task: 't1',
          seq: 0,
          ts,
          data: { evaluation: evaluation('run-1', 'o1') },
        } as never,
        scope,
      );
      exporter.observe(
        {
          type: 'kernel.task.status',
          task: 't1',
          seq: 1,
          ts,
          data: { status: 'completed' },
        } as never,
        scope,
      );
      await exporter.flush();
      return sink;
    };

    const platformWide = await sent(false);
    const runSink = await sent(true);

    expect(platformWide.spans.length).toBeGreaterThan(0);
    expect(platformWide.raw()).not.toContain('langfuse.experiment');
    expect(runSink.raw()).toContain('langfuse.experiment.id');
  });
});
