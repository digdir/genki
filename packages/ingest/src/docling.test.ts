import { readFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { buildConnector, errors } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversionRefused,
  doclingConverter,
  doclingBusyLimitMs,
  doclingBusyWaitMs,
  doclingDocumentTimeoutSeconds,
  doclingIdentity,
  DoclingFailed,
  doclingPollIntervalMs,
  type DoclingOptions,
  type DoclingTaskEvent,
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
  /** How many submits to refuse as busy (503), as genki's middleware in docker/docling does. */
  busy: number;
  /** Submits refused as busy. */
  refused: number;
  /** How many new connections to refuse, as a replica restarting does. */
  down: number;
  /** Stops the replica as a scale-in does: its tasks are gone and its connections closed. */
  stop: () => void;
}

interface Cluster {
  url: string;
  seen: Seen[];
  replicas: Replica[];
  /** Connections the proxy accepted. */
  connections: number;
  /** Connections the proxy holds open now. */
  open: number;
  /** Closes every connection the proxy holds, as a network blip would; the replicas keep their tasks. */
  drop: () => void;
  /** Called when a replica takes a task. */
  onTask?: (replica: Replica) => void;
  /** Called when a replica refuses a submit as busy. */
  onRefuse?: (replica: Replica) => void;
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
  const cluster = {
    seen,
    replicas: [] as Replica[],
    connections: 0,
    open: 0,
  } as unknown as Cluster;
  for (let n = 0; n < replicas; n += 1) {
    const tasks = new Map<string, Task>();
    const sockets = new Set<net.Socket>();
    const replica = {
      tasks,
      submits: 0,
      polls: 0,
      notFound: 0,
      failPolls: 0,
      busy: 0,
      refused: 0,
      down: 0,
    } as unknown as Replica;
    const name = `replica-${n}`;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
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
        if (path === '/v1/convert/file/async' && replica.busy > 0) {
          // A busy replica takes nothing: the answer stays for the replica that takes the file.
          replica.busy -= 1;
          replica.refused += 1;
          cluster.onRefuse?.(replica);
          return json(
            503,
            { detail: 'This replica is converting a file; submit it again on a new connection.' },
            { 'retry-after': '15', 'x-docling-replica': name },
          );
        }
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
        return json(
          200,
          { task_id: id, task_type: 'convert', task_status: 'pending' },
          { 'x-docling-replica': name },
        );
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
    if (replica.down > 0) {
      // A replica restarting: the ingress accepts the connection, and it ends with no answer.
      replica.down -= 1;
      cluster.connections += 1;
      client.destroy();
      return;
    }
    const upstream = net.connect(replica.port, '127.0.0.1');
    cluster.connections += 1;
    cluster.open += 1;
    held.add(client);
    let idle: NodeJS.Timeout | undefined;
    const close = () => {
      clearTimeout(idle);
      if (held.delete(client)) cluster.open -= 1;
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
    busyWaitMs: 20,
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
      // TableFormer fast: as good as accurate on the parser benchmark's table tests, and faster (issue 922).
      ['table_mode', 'fast'],
      ['image_export_mode', 'placeholder'],
      ['document_timeout', String(doclingDocumentTimeoutSeconds)],
    ]);
  });

  it('asks Docling for the full document timeout on the first submit even when the clock moves', async () => {
    const { url, seen } = await doclingServer(['success']);
    let clock = new Date('2026-11-21T10:00:00Z').getTime();
    const docling = converterFor(url, {
      now: () => new Date((clock += 1)),
    });

    await docling.convert(report);

    expect((seen[0] as Seen).form.get('document_timeout')).toBe(
      String(doclingDocumentTimeoutSeconds),
    );
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
        tableformer: 'fast',
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

  it('submits a file whose task was lost twice once more with the pdfium reader, and names that reader in its task line', async () => {
    // A page docling-parse cannot read in 16 GiB killed every replica it reached (exit 137), while
    // pypdfium2 read the whole file in 4 GiB (issue 922).
    const cluster = await doclingCluster([], { replicas: 2, convertMs: 300 });
    const tasks: DoclingTaskEvent[] = [];
    const docling = converterFor(cluster.url, { onTask: (task) => tasks.push(task) });
    let stops = 2;
    cluster.onTask = (replica) => {
      if (stops-- > 0) setTimeout(() => replica.stop(), 100);
    };

    await docling.convert(report);

    const readers = cluster.seen
      .filter((r) => r.path === '/v1/convert/file/async')
      .map((r) => r.form.get('pdf_backend'));
    expect(readers).toEqual([null, null, 'pypdfium2']);
    expect(tasks.map((t) => [t.result, t.pdfBackend])).toEqual([
      ['lost', undefined],
      ['lost', undefined],
      ['success', 'pypdfium2'],
    ]);

    // The next try starts with Docling's own reader again.
    await docling.convert(report);
    expect(cluster.seen.at(-1)?.form.get('pdf_backend')).toBeNull();
  });

  /** The PDF readers the file was submitted with, in order: `null` is Docling's own. */
  const readersOf = (cluster: Cluster) =>
    cluster.seen
      .filter((r) => r.path === '/v1/convert/file/async')
      .map((r) => r.form.get('pdf_backend'));

  it('submits a file Docling answers with partial_success and only backend_failure errors once more with the pdfium reader, and returns its pdfium conversion', async () => {
    // docling-parse failed to parse page 1 of a Kudos file, the same way each try, while pypdfium2
    // read every page (issue 951).
    const cluster = await doclingServer(['partial-page-parse', 'success']);
    const tasks: DoclingTaskEvent[] = [];

    const conversion = await converterFor(cluster.url, {
      onTask: (task) => tasks.push(task),
    }).convert(report);

    expect(readersOf(cluster)).toEqual([null, 'pypdfium2']);
    expect(conversion.pages.join('\n')).toMatch(/\S/);
    expect(tasks.map((t) => [t.submit, t.result, t.pdfBackend])).toEqual([
      [1, 'partial', undefined],
      [2, 'success', 'pypdfium2'],
    ]);
  });

  it('refuses a partial_success with a timeout error as too_large, with no pdfium submit', async () => {
    const cluster = await doclingServer(['partial-timeout', 'success']);

    const refusal = await converterFor(cluster.url)
      .convert(report)
      .catch((e: unknown) => e);

    expect((refusal as ConversionRefused).reason).toBe('too_large');
    expect(readersOf(cluster)).toEqual([null]);
  });

  it("keeps pdfium's partial pages when the pdfium submit is partial too, and tells the task as partial", async () => {
    const cluster = await doclingServer(['partial-page-parse', 'partial-page-parse', 'success']);
    const tasks: DoclingTaskEvent[] = [];

    const conversion = await converterFor(cluster.url, {
      onTask: (task) => tasks.push(task),
    }).convert(report);

    expect(readersOf(cluster)).toEqual([null, 'pypdfium2']);
    expect(conversion.converter).toEqual(doclingIdentity);
    expect(conversion.pages.join('\n')).toMatch(/\S/);
    const output = JSON.parse(new TextDecoder().decode(conversion.output)) as {
      schema_name: string;
    };
    expect(output.schema_name).toBe('DoclingDocument');
    expect(tasks.at(-1)).toMatchObject({ result: 'partial', pdfBackend: 'pypdfium2' });
  });

  it('refuses a file as conversion_failed when its pdfium submit answers with no document', async () => {
    const cluster = await doclingServer([
      'partial-page-parse',
      JSON.stringify({
        status: 'failure',
        errors: [{ component_type: 'document_backend', category: 'backend_failure', page_no: 1 }],
        document: { filename: 'document.pdf', json_content: null },
      }),
    ]);
    const tasks: DoclingTaskEvent[] = [];

    const refusal = await converterFor(cluster.url, {
      onTask: (task) => tasks.push(task),
    })
      .convert(report)
      .catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(ConversionRefused);
    expect((refusal as ConversionRefused).reason).toBe('conversion_failed');
    expect(readersOf(cluster)).toEqual([null, 'pypdfium2']);
    expect(tasks.at(-1)).toMatchObject({ result: 'conversion_failed', pdfBackend: 'pypdfium2' });
  });

  it('tries again a pdfium failure with an inference_failure error after unparsed pages', async () => {
    // Only a page pdfium cannot parse either is about the file; a model that failed may not fail
    // on the next try, and a refusal is never converted again (ADR 0042).
    const cluster = await doclingServer([
      'partial-page-parse',
      JSON.stringify({
        status: 'failure',
        errors: [{ component_type: 'model', category: 'inference_failure', page_no: 1 }],
        document: { filename: 'document.pdf', json_content: null },
      }),
    ]);

    const error = await converterFor(cluster.url)
      .convert(report)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoclingFailed);
    expect(readersOf(cluster)).toEqual([null, 'pypdfium2']);
  });

  it('names only the lost tasks in the error of a try whose pdfium tasks were lost after unparsed pages', async () => {
    const cluster = await doclingCluster(['partial-page-parse'], { replicas: 2, convertMs: 300 });
    // The own reader's task ends partial; both pdfium tasks are lost.
    let taken = 0;
    cluster.onTask = (replica) => {
      taken += 1;
      if (taken > 1) setTimeout(() => replica.stop(), 100);
    };

    const error = await converterFor(cluster.url)
      .convert(report)
      .catch((e: unknown) => e);

    expect(readersOf(cluster)).toEqual([null, 'pypdfium2', 'pypdfium2']);
    expect((error as DoclingFailed).detail).toBe('HTTP 404: the task was lost 2 times');
  });

  it('names a Docling status and category that are not one word as other in a DoclingFailed, in linear time', async () => {
    // Docling's answer is untrusted text, and the detail goes into a dead letter every waiting
    // organisation sees (issue 951).
    const long = 'Page 1 of hemmelig-rapport.pdf failed to parse. '.repeat(20_000);
    const cluster = await doclingServer([
      JSON.stringify({
        status: `Partial Success of hemmelig-rapport.pdf ${long}`,
        errors: [{ component_type: 'pipeline', category: long, page_no: 1 }],
        document: { filename: 'hemmelig-rapport.pdf', json_content: null },
      }),
    ]);

    const started = performance.now();
    const error = await converterFor(cluster.url)
      .convert(report)
      .catch((e: unknown) => e);

    expect((error as DoclingFailed).detail).toBe('HTTP 200: status other with errors other');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("names each error category once in a DoclingFailed's detail", async () => {
    // Docling reports one error per page: a long file must not fill its dead letter with them.
    const errors = Array.from({ length: 300 }, (_, n) => ({
      component_type: 'pipeline',
      category: n % 2 ? 'something_new' : 'backend_failure',
      page_no: n + 1,
    }));
    const cluster = await doclingServer([
      JSON.stringify({ status: 'failure', errors, document: { json_content: null } }),
    ]);

    const error = await converterFor(cluster.url)
      .convert(report)
      .catch((e: unknown) => e);

    expect((error as DoclingFailed).detail).toBe(
      'HTTP 200: status failure with errors backend_failure, something_new',
    );
  });

  it('fails a file whose pdfium submit after two lost tasks comes back partial, so it is still a dead letter', async () => {
    // Keeping partial pages and the text layer follow only pages Docling's own reader could not
    // parse (issue 951); a file sent to pdfium after lost tasks fails as before (issue 944).
    const cluster = await doclingCluster(['success', 'success', 'partial-page-parse'], {
      replicas: 2,
      convertMs: 300,
    });
    let stops = 2;
    cluster.onTask = (replica) => {
      if (stops-- > 0) setTimeout(() => replica.stop(), 100);
    };

    const error = await converterFor(cluster.url)
      .convert(report)
      .catch((e: unknown) => e);

    expect(readersOf(cluster)).toEqual([null, null, 'pypdfium2']);
    expect(error).toBeInstanceOf(DoclingFailed);
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

  it('asks Docling for only the time left in the try when it submits the file again', async () => {
    let clock = new Date('2026-11-21T10:00:00Z').getTime();
    const cluster = await doclingCluster([], { replicas: 2, convertMs: 300 });
    let stops = 1;
    // The first task is lost half an hour into the try.
    cluster.onTask = (replica) => {
      if (stops-- > 0)
        setTimeout(() => {
          clock += 30 * 60_000;
          replica.stop();
        }, 50);
    };

    await converterFor(cluster.url, {
      documentTimeoutSeconds: 3_600,
      now: () => new Date(clock),
    }).convert(report);

    expect(cluster.seen.map((s) => s.form.get('document_timeout'))).toEqual(['3600', '1800']);
  });

  it('submits again on a new connection when a busy replica refuses the file, without counting it as a submit', async () => {
    const cluster = await doclingCluster(['success'], { replicas: 2, convertMs: 100 });
    (cluster.replicas[0] as Replica).busy = 1;
    const lost: number[] = [];

    const conversion = await converterFor(cluster.url, {
      onTaskLost: ({ submits }) => lost.push(submits),
    }).convert(report);

    expect(conversion.converter).toEqual(doclingIdentity);
    expect(cluster.replicas.map((r) => [r.refused, r.submits])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(cluster.connections).toBe(2);
    expect(lost).toEqual([]);
  });

  it('keeps asking a busy server every 15 s for at most 50 minutes, then fails the try', async () => {
    expect(doclingBusyWaitMs).toBe(15_000);
    expect(doclingBusyLimitMs).toBe(50 * 60_000);
    let clock = new Date('2026-11-21T10:00:00Z').getTime();
    const cluster = await doclingCluster(['success']);
    (cluster.replicas[0] as Replica).busy = Infinity;
    // Each refusal takes ten minutes: past the 50 minutes after the sixth.
    cluster.onRefuse = () => {
      clock += 10 * 60_000;
    };

    const error = await converterFor(cluster.url, { now: () => new Date(clock) })
      .convert(report)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoclingFailed);
    expect(String((error as Error).message)).toContain('no replica took the file');
    expect(cluster.replicas[0]?.refused).toBe(6);
    expect(cluster.replicas[0]?.submits).toBe(0);
  });

  it('asks Docling for the full document timeout after waiting for a replica', async () => {
    let clock = new Date('2026-11-21T10:00:00Z').getTime();
    const cluster = await doclingCluster(['success']);
    (cluster.replicas[0] as Replica).busy = 2;
    cluster.onRefuse = () => {
      clock += 20 * 60_000;
    };

    await converterFor(cluster.url, { now: () => new Date(clock) }).convert(report);

    // The document timeout runs from when a replica takes the file, not from the first ask.
    expect(cluster.seen.at(-1)?.form.get('document_timeout')).toBe(
      String(doclingDocumentTimeoutSeconds),
    );
  });

  it('keeps a refused connection open while it waits, so a waiting job still counts toward scaling', async () => {
    const cluster = await doclingCluster(['success'], { replicas: 2, convertMs: 50 });
    (cluster.replicas[0] as Replica).busy = 1;
    const during: number[] = [];
    cluster.onRefuse = () => setTimeout(() => during.push(cluster.open), 100);

    await converterFor(cluster.url, { busyWaitMs: 300 }).convert(report);

    expect(during).toEqual([1]);
  });

  it('fails a submit answered 503 by something other than a Docling replica, without waiting', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"detail":"Service Unavailable"}');
    });
    const port = await listen(server);

    const error = await converterFor(`http://127.0.0.1:${port}`)
      .convert(report)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DoclingFailed);
    expect((error as DoclingFailed).status).toBe(503);
  });

  it('fails the try after 8 submits in a row end without an answer', async () => {
    const cluster = await doclingCluster(['success']);
    (cluster.replicas[0] as Replica).down = 10;

    const error = await converterFor(cluster.url)
      .convert(report)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(cluster.connections).toBe(8);
    expect(cluster.replicas[0]?.submits).toBe(0);
  });

  it('reports one task line when a task ends, with its task id, sha256, pages, submit number, replica, times and result', async () => {
    const cluster = await doclingCluster(['success'], { replicas: 2, convertMs: 100 });
    const tasks: DoclingTaskEvent[] = [];

    await converterFor(cluster.url, {
      countPages: async () => 7,
      onTask: (event) => tasks.push(event),
    }).convert(report);

    expect(tasks).toEqual([
      {
        task: expect.stringMatching(/^[\w-]{36}$/) as unknown,
        sha256: createHash('sha256').update(report.bytes).digest('hex'),
        pages: 7,
        submit: 1,
        replica: 'replica-0',
        queuedMs: expect.any(Number) as unknown,
        convertingMs: expect.any(Number) as unknown,
        result: 'success',
        busyWaits: 0,
      },
    ]);
  });

  it('reports a lost task with the pages counted from the PDF before it was submitted', async () => {
    const cluster = await doclingCluster([], { replicas: 2, convertMs: 300 });
    const order: string[] = [];
    const tasks: DoclingTaskEvent[] = [];
    let stops = 1;
    cluster.onTask = (replica) => {
      order.push('submit');
      if (stops-- > 0) setTimeout(() => replica.stop(), 100);
    };

    await converterFor(cluster.url, {
      countPages: async () => {
        order.push('count');
        return 452;
      },
      onTask: (event) => tasks.push(event),
    }).convert(report);

    expect(order).toEqual(['count', 'submit', 'submit']);
    expect(tasks.map((t) => [t.result, t.submit, t.pages])).toEqual([
      ['lost', 1, 452],
      ['success', 2, 452],
    ]);
    // The lost task names the replica that was stopped, so its kill can be matched to the file.
    expect(tasks[0]?.replica).toBe('replica-0');
  });

  it('counts the busy answers before a task in its task line', async () => {
    const cluster = await doclingCluster(['success'], { convertMs: 50 });
    (cluster.replicas[0] as Replica).busy = 2;
    const tasks: DoclingTaskEvent[] = [];

    await converterFor(cluster.url, { onTask: (event) => tasks.push(event) }).convert(report);

    expect(tasks.map((t) => [t.result, t.busyWaits])).toEqual([['success', 2]]);
  });

  it('submits again on a new connection when the replica is restarting and refuses the connection', async () => {
    const cluster = await doclingCluster(['success'], { replicas: 2, convertMs: 50 });
    (cluster.replicas[0] as Replica).down = 1;

    const conversion = await converterFor(cluster.url).convert(report);

    expect(conversion.converter).toEqual(doclingIdentity);
    expect(cluster.replicas.map((r) => r.submits)).toEqual([0, 1]);
  });

  it('fails a submit whose answer times out at once, without asking again', async () => {
    let submits = 0;
    const server = http.createServer((req) => {
      // Takes the file and never answers, as a hung server does.
      submits += 1;
      req.resume();
    });
    const port = await listen(server);

    const error = await converterFor(`http://127.0.0.1:${port}`, { headersTimeoutMs: 100 })
      .convert(report)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(submits).toBe(1);
  });

  it('waits and asks again when a connection to Docling times out, as while replicas start', async () => {
    const cluster = await doclingCluster(['success'], { convertMs: 50 });
    const tasks: DoclingTaskEvent[] = [];
    // The ingress holds a connection while every replica is taken and the next one starts: the
    // first 12 connects give up as undici's 10 s connect timeout does, more than the 8 early ends.
    let timeouts = 12;
    const direct = buildConnector({});
    const connect: buildConnector.connector = (options, callback) => {
      if (timeouts-- > 0) {
        setTimeout(() => callback(new errors.ConnectTimeoutError(), null), 5);
        return;
      }
      direct(options, callback);
    };

    const conversion = await converterFor(cluster.url, {
      connect,
      onTask: (event) => tasks.push(event),
    }).convert(report);

    expect(conversion.converter).toEqual(doclingIdentity);
    expect(tasks.map((t) => [t.result, t.submit, t.busyWaits])).toEqual([['success', 1, 12]]);
  });
});
