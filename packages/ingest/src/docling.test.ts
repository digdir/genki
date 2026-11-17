import { readFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConversionRefused,
  doclingConverter,
  doclingDocumentTimeoutSeconds,
  doclingHeadersTimeoutMs,
  doclingIdentity,
  DoclingFailed,
} from './index.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/docling/${name}.json`, import.meta.url), 'utf8');

/** A recorded answer: its status and body, or the raw bytes of a success. */
const recorded = (name: string): { status: number; body: string } => {
  if (name === 'success') return { status: 200, body: fixture('success') };
  const { status, body } = JSON.parse(fixture(name)) as { status: number; body: unknown };
  return { status, body: JSON.stringify(body) };
};

interface Seen {
  method: string;
  path: string;
  key: string | undefined;
  form: FormData;
}

const servers: http.Server[] = [];

/** A Docling server that answers each request with the next recorded answer. */
const doclingServer = async (answers: string[]) => {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const form = await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': req.headers['content-type'] ?? '' },
    }).formData();
    const key = req.headers['x-api-key'];
    seen.push({
      method: req.method ?? '',
      path: req.url ?? '',
      key: typeof key === 'string' ? key : undefined,
      form,
    });
    const answer = recorded(answers.shift() ?? 'success');
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(answer.body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(() => resolve(undefined)))),
  );
});

const report = {
  name: 'arsrapport-2025-direktoratet.pdf',
  bytes: new TextEncoder().encode('%PDF-1.4 a report'),
  mimetype: 'application/pdf',
};

const converterFor = (url: string) =>
  doclingConverter({ url, credential: { kind: 'api-key', key: async () => 'docling-key' } });

describe('the Docling client', () => {
  it('the Docling client makes one request per job and asks the server to keep nothing', async () => {
    const { url, seen } = await doclingServer(['sync-wait-504', 'success']);
    const docling = converterFor(url);

    await expect(docling.convert(report)).rejects.toBeInstanceOf(DoclingFailed);
    expect(seen).toHaveLength(1);

    await docling.convert(report);
    expect(seen).toHaveLength(2);
    const request = seen[1] as Seen;
    // The synchronous route, so no task or result is left on the server to fetch later.
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/convert/file');
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
    ['sync-wait-504', 504],
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
    const { url, seen } = await doclingServer([]);
    seen.length = 0;
    const server = servers[0] as http.Server;
    server.removeAllListeners('request');
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'failure',
            errors: [{ component_type: 'pipeline', category: 'something_new', page_no: null }],
            document: { filename: 'document.pdf', json_content: null },
          }),
        );
      });
    });

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

  it("the Docling client keeps its connection alive and waits past the server's own limit", async () => {
    const keepAlive = vi.spyOn(net.Socket.prototype, 'setKeepAlive');
    const { url } = await doclingServer(['success']);

    await converterFor(url).convert(report);

    // Probes every 30 seconds keep a connection that sends nothing while Docling works open.
    expect(keepAlive).toHaveBeenCalledWith(true, 30_000);
    const template = readFileSync(
      new URL('../../../infra/modules/containerapps.bicep', import.meta.url),
      'utf8',
    );
    const serverWait = Number(/DOCLING_SERVE_MAX_SYNC_WAIT', value: '(\d+)'/.exec(template)?.[1]);
    expect(serverWait).toBeGreaterThan(doclingDocumentTimeoutSeconds);
    expect(doclingHeadersTimeoutMs).toBeGreaterThan(serverWait * 1000);
  });
});
