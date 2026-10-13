import type { Input, Part } from '@genai/contracts';
import {
  KernelError,
  type Capability,
  type Emitted,
  type InvocationContext,
  type Strategy,
} from '@genai/kernel';
import { blobFolderKind, blobPart, readablePart, type BlobPort } from '@genai/port-blob';
import { z } from 'zod';

export const batchConfig = z.strictObject({
  capability: z.string().min(1),
  concurrency: z.number().int().min(1).max(32).default(4),
  retries: z.number().int().min(0).max(10).default(2),
  backoffMs: z.number().int().min(0).max(600_000).default(1000),
  folder: z.string().optional(),
  resultFolder: z.string().min(1).default('results'),
});

export type BatchConfig = z.infer<typeof batchConfig>;

export const batchRuntimeConfig = z.looseObject({
  strategy: batchConfig,
  tenant: z.string().optional(),
});

const batchInput = z.looseObject({
  batchId: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,80}$/)
    .optional(),
  items: z.array(z.strictObject({ id: z.string().min(1), input: z.looseObject({}) })).optional(),
  folder: z.string().optional(),
});

export interface BatchItemResult {
  id: string;
  status: 'succeeded' | 'failed';
  attempts: number;
  task?: string;
  text?: string;
  json?: unknown;
  error?: string;
}

export interface BatchResult {
  batchId: string;
  capability: string;
  total: number;
  succeeded: number;
  failed: number;
  items: BatchItemResult[];
  score?: unknown;
}

export const batchResultMime = 'application/vnd.genai.batch-result+json';

const permanent = new Set(['forbidden', 'not_found', 'misconfigured']);

const isPermanent = (error: unknown) => error instanceof KernelError && permanent.has(error.code);

const summarise = (parts: Part[]) => {
  const text = parts.flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : [])).join('\n');
  const json = parts.find((p) => p.body.kind === 'json');
  return {
    ...(text ? { text } : {}),
    ...(json && json.body.kind === 'json' ? { json: json.body.json } : {}),
  };
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const channel = <T>() => {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  return {
    push(value: T) {
      queue.push(value);
      wake?.();
    },
    async next(): Promise<T> {
      while (queue.length === 0) await new Promise<void>((r) => (wake = r));
      wake = undefined;
      return queue.shift() as T;
    },
  };
};

const folderRef = (config: z.infer<typeof batchRuntimeConfig>) => ({
  kind: blobFolderKind,
  id: config.strategy.folder ?? '',
  ...(config.tenant ? { tenant: config.tenant } : {}),
});

const itemsFromFolder = async (port: BlobPort, subfolder: string) => {
  const { tenant, prefix } = port.folder();
  const sub = subfolder === '' || subfolder.endsWith('/') ? subfolder : `${subfolder}/`;
  const listed = (await port.list(sub)).filter(
    (info) => !info.path.slice(sub.length).includes('/'),
  );
  return Promise.all(
    listed.map(async (info) => {
      const name = info.path.slice(sub.length);
      const full = { ...info, tenant, path: `${prefix}${info.path}` };
      const body = (await port.get(info.path))?.body;
      const input: Input = { parts: [readablePart(full, body)], data: { name } };
      return { id: name.replace(/\.[^.]+$/, ''), input };
    }),
  );
};

export const runBatch = async function* (
  ctx: InvocationContext,
  rawInput: Input,
  config: z.infer<typeof batchRuntimeConfig>,
): AsyncGenerator<Emitted> {
  const input = batchInput.parse(rawInput.data ?? {});
  const batchId = input.batchId ?? ctx.task;
  const { capability, concurrency, retries, backoffMs, resultFolder } = config.strategy;
  const port =
    config.strategy.folder !== undefined || input.folder !== undefined
      ? await ctx.use<BlobPort>('blob', folderRef(config))
      : undefined;
  const items = input.items ?? (port ? await itemsFromFolder(port, input.folder ?? '') : []);
  if (items.length === 0) throw new Error('the batch has no items');
  if (new Set(items.map((i) => i.id)).size !== items.length)
    throw new Error('batch item ids must be unique');

  const stateKey = `batch:${batchId}`;
  const saved = await ctx.state.get<Record<string, BatchItemResult>>('principal', stateKey);
  const done: Record<string, BatchItemResult> = { ...(saved?.value ?? {}) };
  let version = saved?.v;
  let writes = Promise.resolve();
  const record = (result: BatchItemResult) => {
    done[result.id] = result;
    writes = writes.then(async () => {
      version = await ctx.state.put('principal', stateKey, done, version);
      await ctx.state.checkpoint({ batchId, done: Object.keys(done).length, total: items.length });
    });
    return writes;
  };

  const events = channel<Emitted | 'finished'>();
  const todo = items.filter((i) => done[i.id]?.status !== 'succeeded');
  const progress = (item: BatchItemResult): Emitted => {
    const all = Object.values(done);
    return {
      type: 'kernel.notice',
      data: {
        kind: 'batch-progress',
        batchId,
        item: item.id,
        status: item.status,
        done: all.length,
        succeeded: all.filter((r) => r.status === 'succeeded').length,
        failed: all.filter((r) => r.status === 'failed').length,
        total: items.length,
      },
    };
  };

  const work = async (item: { id: string; input: Input }) => {
    let lastError = '';
    let lastTask: string | undefined;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      ctx.signal.throwIfAborted();
      try {
        const run = await ctx.invoke(capability, item.input);
        lastTask = run.task;
        const parts = await run.result;
        return {
          id: item.id,
          status: 'succeeded' as const,
          attempts: attempt,
          task: run.task,
          ...summarise(parts),
        };
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        if (isPermanent(error) || attempt > retries) {
          return {
            id: item.id,
            status: 'failed' as const,
            attempts: attempt,
            ...(lastTask ? { task: lastTask } : {}),
            error: lastError,
          };
        }
        await sleep(backoffMs * 2 ** (attempt - 1), ctx.signal);
      }
    }
    return { id: item.id, status: 'failed' as const, attempts: retries + 1, error: lastError };
  };

  const queue = [...todo];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const result = await work(item);
      await record(result);
      events.push(progress(result));
    }
  });
  void Promise.allSettled(workers).then(() => events.push('finished'));

  for (let event = await events.next(); event !== 'finished'; event = await events.next())
    yield event;
  const failures = (await Promise.allSettled(workers)).find((w) => w.status === 'rejected');
  if (failures && failures.status === 'rejected') throw failures.reason;
  await writes;

  const ordered = items.map((i) => done[i.id] as BatchItemResult);
  const result: BatchResult = {
    batchId,
    capability,
    total: items.length,
    succeeded: ordered.filter((r) => r.status === 'succeeded').length,
    failed: ordered.filter((r) => r.status === 'failed').length,
    items: ordered,
  };
  const parts: Part[] = [{ mime: batchResultMime, body: { kind: 'json', json: result } }];
  if (port) {
    const info = await port.put(
      `${resultFolder}/${batchId}.json`,
      new TextEncoder().encode(`${JSON.stringify(result, null, 2)}\n`),
      'application/json',
    );
    const { tenant, prefix } = port.folder();
    parts.push(blobPart({ ...info, tenant, path: `${prefix}${info.path}` }));
  }
  yield { type: 'kernel.result', data: parts };
};

export const batchStrategy: Strategy<z.infer<typeof batchRuntimeConfig>> = {
  id: 'batch',
  version: '1',
  requires: { kernel: 1, ports: ['blob'], features: ['subinvoke', 'checkpoint'] },
  run: (ctx, input, config) => runBatch(ctx, input, batchRuntimeConfig.parse(config)),
};

export const batchCapabilityFor = (
  compiled: { capability: Capability; service: { tenant: string; id: string } },
  options: { folder?: string; concurrency?: number; retries?: number } = {},
): Capability => {
  const folder = options.folder ?? compiled.service.id;
  return {
    descriptor: {
      ...compiled.capability.descriptor,
      id: `${compiled.capability.descriptor.id}.batch`,
      title: `${compiled.capability.descriptor.title} (batch)`,
      interaction: ['async'],
    },
    strategy: { id: 'batch', version: '1' },
    config: {
      strategy: {
        capability: compiled.capability.descriptor.id,
        folder,
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        ...(options.retries === undefined ? {} : { retries: options.retries }),
      },
      tenant: compiled.service.tenant,
    },
    grants: [
      { port: 'blob', ref: { kind: blobFolderKind, id: folder, tenant: compiled.service.tenant } },
    ],
  };
};
