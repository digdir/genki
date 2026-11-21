import { readFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversionRefused,
  doclingConverter,
  doclingDocumentTimeoutSeconds,
  doclingIdentity,
  DoclingFailed,
  doclingPollIntervalMs,
  type DoclingOptions,
} from './index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/docling/${name}.json`, import.meta.url), 'utf8');

/** A recorded answer: its status and body, or the raw bytes of a success. */
const recorded = (name: string): { status: number; body: string } => {
  if (name === 'success') return { status: 200, body: fixture('success') };
  if (name.startsWith('{')) return { status: 200, body: name };
  const { status, body } = JSON.parse(fixture(name)) as { status: number; body: unknown };
  return { status, body: JSON.stringify(body) };
};

interface Seen {
  method: string;
  path: string;
  key: string | undefined;
  form: FormData;
}

interface Task {
  doneAt: number;
  answer: { status: number; body: string };
}

/** One Docling replica: its own tasks in memory, as docling-serve's `local` engine keeps them. */
interface Replica {
  port: number;
  tasks: Map<string, Task>;
  submits: number;
  polls: number;
  notFound: number;
  /** How many polls of a known task to answer 503 first. */
  failPolls: number;
  /** Stops the replica as a scale-in does: its tasks are gone and its connections closed. */
  stop: () => void;
}

interface Cluster {
  url: string;
  seen: Seen[];
  replicas: Replica[];
  /** Connections the proxy accepted. */
  connections: number;
  /** Closes every connection the proxy holds, as a network blip would; the replicas keep their tasks. */
  drop: () => void;
  /** Called when a replica takes a task. */
  onTask?: (replica: Replica) => void;
}

const servers: { close: (callback: () => void) => void }[] = [];
const closing: (() => void)[] = [];

const listen = async (server: http.Server | net.Server) => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Docling behind the Container Apps TCP ingress, in miniature: replicas that answer the synchronous
 * and the async routes, each converting for `convertMs`, and a proxy that sends each new
 * connection to the next replica and closes a connection idle for `idleMs` (300 s in genki-test).
 */
const doclingCluster = async (
  answers: string[],
  { replicas = 1, convertMs = 0, idleMs = 0 } = {},
): Promise<Cluster> => {
  const seen: Seen[] = [];
  const cluster = { seen, replicas: [] as Replica[], connections: 0 } as unknown as Cluster;
  for (let n = 0; n < replicas; n += 1) {
    const tasks = new Map<string, Task>();
    const sockets = new Set<net.Socket>();
    const replica = {
      tasks,
      submits: 0,
      polls: 0,
      notFound: 0,
      failPolls: 0,
    } as unknown as Replica;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const path = req.url ?? '';
      if (req.method === 'POST' && path.startsWith('/v1/convert/file')) {
        const form = await new Response(Buffer.concat(chunks), {
          headers: { 'content-type': req.headers['content-type'] ?? '' },
        }).formData();
        const key = req.headers['x-api-key'];
        seen.push({
          method: req.method,
          path,
          key: typeof key === 'string' ? key : undefined,
          form,
        });
        const answer = recorded(answers.shift() ?? 'success');
        if (path === '/v1/convert/file') {
          // The synchronous route sends nothing until the conversion is done.
          await delay(convertMs);
          if (!res.destroyed) json(answer.status, answer.body);
          return;
        }
        if (answer.status === 401 || answer.status === 422) return json(answer.status, answer.body);
        const id = randomUUID();
        tasks.set(id, { doneAt: Date.now() + convertMs, answer });
        replica.submits += 1;
        cluster.onTask?.(replica);
        return json(200, { task_id: id, task_type: 'convert', task_status: 'pending' });
      }
      const poll = /^\/v1\/status\/poll\/([\w-]+)/.exec(path);
      if (req.method === 'GET' && poll) {
        const task = tasks.get(poll[1] ?? '');
        if (!task) {
          replica.notFound += 1;
          return json(404, { detail: 'Task not found.' });
        }
        replica.polls += 1;
        if (replica.failPolls > 0) {
          replica.failPolls -= 1;
          return json(503, { detail: 'Service Unavailable' });
        }
        const done = Date.now() >= task.doneAt;
        return json(200, { task_id: poll[1], task_status: done ? 'success' : 'started' });
      }
      const result = /^\/v1\/result\/([\w-]+)$/.exec(path);
      if (req.method === 'GET' && result) {
        const task = tasks.get(result[1] ?? '');
        if (!task) return json(404, { detail: 'Task not found.' });
        // A result is removed once fetched; a missing one leaves its task, as docling-serve does.
        if (task.answer.status === 200) tasks.delete(result[1] ?? '');
        return json(task.answer.status, task.answer.body);
      }
      json(404, { detail: 'Not Found' });
    });
    server.on('connection', (socket: net.Socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    replica.port = await listen(server);
    replica.stop = () => {
      tasks.clear();
      for (const socket of sockets) socket.destroy();
    };
    cluster.replicas.push(replica);
    closing.push(() => replica.stop());
  }
  const held = new Set<net.Socket>();
  let next = 0;
  const proxy = net.createServer((client) => {
    const replica = cluster.replicas[next % cluster.replicas.length] as Replica;
    next += 1;
    const upstream = net.connect(replica.port, '127.0.0.1');
    cluster.connections += 1;
    held.add(client);
    let idle: NodeJS.Timeout | undefined;
    const close = () => {
      clearTimeout(idle);
      held.delete(client);
      client.end();
      client.destroy();
      upstream.destroy();
    };
    const active = () => {
      clearTimeout(idle);
      if (idleMs > 0) idle = setTimeout(close, idleMs);
    };
    active();
    client.on('data', (data) => {
      active();
      upstream.write(data);
    });
    upstream.on('data', (data) => {
      active();
      client.write(data);
    });
    client.on('close', close);
    upstream.on('close', close);
    client.on('error', close);
    upstream.on('error', close);
  });
  const port = await listen(proxy);
  cluster.url = `http://127.0.0.1:${port}`;
  cluster.drop = () => {
    for (const socket of held) socket.destroy();
  };
  closing.push(() => cluster.drop());
  return cluster;
};

/** A Docling server that answers each request with the next recorded answer. */
const doclingServer = async (answers: string[]) => doclingCluster(answers);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closing.splice(0)) close();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(() => resolve(undefined)))),
  );
});

const report = {
  name: 'arsrapport-2025-direktoratet.pdf',
  bytes: new TextEncoder().encode('%PDF-1.4 a report'),
  mimetype: 'application/pdf',
};

const converterFor = (url: string, options: Partial<DoclingOptions> = {}) =>
  doclingConverter({
    url,
    credential: { kind: 'api-key', key: async () => 'docling-key' },
    pollIntervalMs: 20,
    ...options,
  });

describe('the Docling client', () => {
  it('the Docling client submits each file once to the async route', async () => {
    const { url, seen } = await doclingServer(['unauthorized', 'success']);
    const docling = converterFor(url);

    await expect(docling.convert(report)).rejects.toBeInstanceOf(DoclingFailed);
    expect(seen).toHaveLength(1);

    await docling.convert(report);
    expect(seen).toHaveLength(2);
    const request = seen[1] as Seen;
    // The async route: the client polls the task, so no connection waits in silence (issue 906).
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/convert/file/async');
    expect(request.key).toBe('docling-key');
    const file = request.form.get('files') as File;
    // A name that says nothing: the server's logs name the file it was sent.
    expect(file.name).toBe('document.pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(report.bytes);
    expect(
      [...request.form.entries()].filter(([k]) => k !== 'files').map(([k, v]) => [k, v]),
    ).toEqual([
      ['to_formats', 'json'],
      ['ocr_preset', 'tesseract'],
      ['ocr_lang', 'nor'],
      ['table_mode', 'accurate'],
      ['image_export_mode', 'placeholder'],
      ['document_timeout', String(doclingDocumentTimeoutSeconds)],
    ]);
  });

  it('reads a successful conversion into pages and keeps its native output', async () => {
    const { url } = await doclingServer(['success']);

    const conversion = await converterFor(url).convert(report);

    expect(conversion.converter).toEqual(doclingIdentity);
    expect(conversion.pages.length).toBeGreaterThan(0);
    expect(conversion.pages.join('\n')).toMatch(/\S/);
    const output = JSON.parse(new TextDecoder().decode(conversion.output)) as {
      schema_name: string;
    };
    expect(output.schema_name).toBe('DoclingDocument');
  });

  it("the native output keeps Docling's binary_hash digits exactly", async () => {
    const { url } = await doclingServer(['success']);

    const conversion = await converterFor(url).convert(report);

    // 10360526012877778318 is above 2^53; JSON.parse alone would write 10360526012877779000.
    expect(fixture('success')).toContain('"binary_hash":10360526012877778318');
    expect(new TextDecoder().decode(conversion.output)).toContain(
      '"binary_hash":10360526012877778318',
    );
  });

  it.each(['failure-corrupt', 'failure-password', 'failure-not-pdf'])(
    'refuses a file Docling cannot open (%s) as conversion_failed',
    async (answer) => {
      const { url } = await doclingServer([answer]);

      const refusal = await converterFor(url)
        .convert(report)
        .catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ConversionRefused);
      expect((refusal as ConversionRefused).reason).toBe('conversion_failed');
    },
  );

  it('refuses a file that is not a PDF as unsupported_type without asking the server', async () => {
    const { url, seen } = await doclingServer(['success']);
    const word = {
      name: '3f2c7a90-1b4d-4e6f-9a8b-2c1d0e9f8a7b',
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
    };

    const refusal = await converterFor(url)
      .convert(word)
      .catch((e: unknown) => e);

    expect((refusal as ConversionRefused).reason).toBe('unsupported_type');
    expect(seen).toEqual([]);
    // A KUDOS file is named by its id alone: a PDF is known by its first bytes.
    await converterFor(url).convert({ name: word.name, bytes: report.bytes });
    expect(seen).toHaveLength(1);
  });

  it.each(['failure-over-size', 'partial-timeout'])(
    'refuses a file over Docling limits or its document timeout (%s) as too_large',
    async (answer) => {
      const { url } = await doclingServer([answer]);

      const refusal = await converterFor(url)
        .convert(report)
        .catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(ConversionRefused);
      expect((refusal as ConversionRefused).reason).toBe('too_large');
    },
  );

  it.each([
    ['unauthorized', 401],
    ['invalid-option', 422],
    ['task-not-found', 404],
  ])(
    'fails an answer that is not about the file (%s) without naming the file',
    async (answer, status) => {
      const { url } = await doclingServer([answer]);

      const error = await converterFor(url)
        .convert(report)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DoclingFailed);
      expect((error as DoclingFailed).status).toBe(status);
      expect(String((error as Error).message)).not.toContain(report.name);
    },
  );

  it('fails a failure body of a category it does not know, so the job tries again', async () => {
    const { url } = await doclingServer([
      JSON.stringify({
        status: 'failure',
        errors: [{ component_type: 'pipeline', category: 'something_new', page_no: null }],
        document: { filename: 'document.pdf', json_content: null },
      }),
    ]);

    await expect(converterFor(url).convert(report)).rejects.toBeInstanceOf(DoclingFailed);
  });

  it('a dropped connection is an error the job tries again, not a refusal', async () => {
    const server = net.createServer((socket) => socket.once('data', () => socket.destroy()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const error = await converterFor(`http://127.0.0.1:${port}`)
        .convert(report)
        .catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(ConversionRefused);
      expect(error).toBeInstanceOf(Error);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });

  it('the Docling client names the Docling version docker/docling pins', () => {
    const requirements = readFileSync(
      new URL('../../../docker/docling/requirements.txt', import.meta.url),
      'utf8',
    );
    const pinned = /^docling==([^\s]+)/m.exec(requirements)?.[1];

    expect(doclingIdentity).toEqual({
      name: 'docling',
      version: pinned,
      settings: {
        pipeline: 'standard',
        ocr: 'tesseract',
        languages: ['nor'],
        tableformer: 'accurate',
      },
    });
  });

  it('polls well inside the ingress idle limit and the server keep-alive', () => {
    // genki-test closes a TCP connection idle for 300 s (issue 906); docling-serve closes an idle
    // keep-alive connection after 60 s (uvicorn's timeout_keep_alive), which would move the next
    // poll to a new connection and perhaps another replica.
    expect(doclingPollIntervalMs).toBeLessThan(60_000);
    const dockerfile = readFileSync(
      new URL('../../../docker/docling/Dockerfile', import.meta.url),
      'utf8',
    );
    expect(dockerfile).not.toContain('UVICORN_TIMEOUT_KEEP_ALIVE');
  });

  it('keeps a conversion alive through a proxy that closes connections idle longer than its limit', async () => {
    const { url, replicas } = await doclingCluster(['success'], { convertMs: 600, idleMs: 150 });

    const conversion = await converterFor(url).convert(report);

    expect(conversion.converter).toEqual(doclingIdentity);
    expect(replicas[0]?.submits).toBe(1);
  });

  it("polls a task on the job's own connection, so every poll reaches the replica that holds it", async () => {
    const cluster = await doclingCluster(['success'], { replicas: 3, convertMs: 200 });

    await converterFor(cluster.url).convert(report);

    expect(cluster.replicas.reduce((n, r) => n + r.polls, 0)).toBeGreaterThan(1);
    expect(cluster.replicas.map((r) => r.notFound)).toEqual([0, 0, 0]);
    expect(cluster.connections).toBe(1);
  });

  it('finds its task again on a new connection after a drop, without submitting the file twice', async () => {
    // Three replicas: the connection after the drop and the first one the search opens both reach
    // a replica without the task.
    const cluster = await doclingCluster(['success'], { replicas: 3, convertMs: 300 });
    cluster.onTask = () => setTimeout(() => cluster.drop(), 100);

    const conversion = await converterFor(cluster.url).convert(report);

    expect(conversion.converter).toEqual(doclingIdentity);
    expect(cluster.replicas.reduce((n, r) => n + r.submits, 0)).toBe(1);
  });

  it('submits the file again when no replica knows its task, at most 3 times a try', async () => {
    const cluster = await doclingCluster([], { replicas: 2, convertMs: 300 });
    const lost: number[] = [];
    const docling = converterFor(cluster.url, { onTaskLost: ({ submits }) => lost.push(submits) });
    // The replica that took the task is stopped once, as a scale-in does.
    let stops = 1;
    cluster.onTask = (replica) => {
      if (stops-- > 0) setTimeout(() => replica.stop(), 100);
    };

    await docling.convert(report);
    expect(cluster.replicas.reduce((n, r) => n + r.submits, 0)).toBe(2);
    expect(lost).toEqual([1]);

    // Stopped every time: the try ends after its third submit, and the job tries again.
    stops = Infinity;
    const error = await docling.convert(report).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DoclingFailed);
    expect(cluster.replicas.reduce((n, r) => n + r.submits, 0)).toBe(5);
    // Every lost task is told, the last one too, so the count operators read is whole.
    expect(lost).toEqual([1, 1, 2, 3]);
    expect(String((error as Error).message)).not.toContain(report.name);
  });

  it('stops ten minutes past the document timeout, counted from the first submit', async () => {
    let clock = new Date('2026-11-21T10:00:00Z').getTime();
    const cluster = await doclingCluster([], { replicas: 2, convertMs: 10_000_000 });
    const docling = converterFor(cluster.url, {
      documentTimeoutSeconds: 60,
      now: () => new Date(clock),
    });
    // The task is lost after the try's deadline has passed: the file is not submitted again.
    cluster.onTask = (replica) =>
      setTimeout(() => {
        clock += 11 * 60_000 + 1;
        replica.stop();
      }, 50);

    const error = await docling.convert(report).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoclingFailed);
    expect(cluster.replicas.reduce((n, r) => n + r.submits, 0)).toBe(1);
  });

  it('fails a task Docling ended without a result, without searching or submitting again', async () => {
    const cluster = await doclingCluster(['task-not-found'], { replicas: 2 });
    const lost: number[] = [];

    const error = await converterFor(cluster.url, {
      onTaskLost: ({ submits }) => lost.push(submits),
    })
      .convert(report)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoclingFailed);
    expect((error as DoclingFailed).status).toBe(404);
    expect(cluster.connections).toBe(1);
    expect(lost).toEqual([]);
  });

  it('keeps polling a task through a server error, without submitting the file again', async () => {
    const cluster = await doclingCluster(['success'], { convertMs: 100 });
    (cluster.replicas[0] as Replica).failPolls = 2;

    const conversion = await converterFor(cluster.url).convert(report);

    expect(conversion.converter).toEqual(doclingIdentity);
    expect(cluster.replicas[0]?.submits).toBe(1);
  });

  it('stops polling a task that runs past the document timeout', async () => {
    let clock = new Date('2026-11-21T10:00:00Z').getTime();
    const cluster = await doclingCluster([], { convertMs: 10_000_000 });
    cluster.onTask = () =>
      setTimeout(() => {
        clock += 11 * 60_000 + 1;
      }, 50);

    const error = await converterFor(cluster.url, {
      documentTimeoutSeconds: 60,
      now: () => new Date(clock),
    })
      .convert(report)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoclingFailed);
    expect(String((error as Error).message)).toContain('past its document timeout');
  });

  it('fails the try after 10 server errors in a row, without submitting the file again', async () => {
    const cluster = await doclingCluster(['success'], { convertMs: 10_000_000 });
    (cluster.replicas[0] as Replica).failPolls = Infinity;

    const error = await converterFor(cluster.url)
      .convert(report)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoclingFailed);
    expect((error as DoclingFailed).status).toBe(503);
    expect(cluster.replicas[0]?.submits).toBe(1);
  });

  it('keeps a replica that answers a server error during the search, without submitting the file again', async () => {
    const cluster = await doclingCluster(['success'], { replicas: 3, convertMs: 300 });
    const lost: number[] = [];
    cluster.onTask = (replica) =>
      setTimeout(() => {
        replica.failPolls = 6;
        cluster.drop();
      }, 100);

    const conversion = await converterFor(cluster.url, {
      onTaskLost: ({ submits }) => lost.push(submits),
    }).convert(report);

    expect(conversion.converter).toEqual(doclingIdentity);
    expect(cluster.replicas.reduce((n, r) => n + r.submits, 0)).toBe(1);
    expect(lost).toEqual([]);
  });
});
