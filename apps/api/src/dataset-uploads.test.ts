import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import type { DocumentConverter } from '@genai/ingest';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { IndexWriterRouter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { createDatasetUploadsModule, uploadName } from './dataset-uploads.js';
import { indexIngestionBackend } from './index-ingestion.js';

const digdir = '991825827';
const other = '999888777';
const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
};

const converter: DocumentConverter = {
  toMarkdown: async (file) => `# ${file.name}\n\nTekst fra PDF-en ${file.name}.`,
};

const boot = async () => {
  const engine = memoryEngine();
  const writers = new IndexWriterRouter({
    catalog: {
      endpoints: { local: { engine: 'memory' } },
      datasets: [{ id: `${digdir}/opplastet`, endpoint: 'local', residency: 'norway' }],
    },
    adapters: [engine.writer],
    knowledgeAdapters: [engine.adapter],
    secrets: envSecrets({}),
  });
  const blobs = new InMemoryBlobStore();
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    blobStore: blobs,
    configurables: {
      scheduleIntervalMs: 0,
      ingestion: indexIngestionBackend({
        writers,
        residencyOf: () => 'norway',
        platformTenant: digdir,
        uploads: blobs,
        converter,
      }),
    },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    modules: [createDatasetUploadsModule({ maxBytes: 100, maxFiles: 3, maxRequestBytes: 4096 })],
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (path: string, as: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': 'Testendring',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const upload = (as: string, files: File[], dataset = 'opplastet', tenant = digdir) => {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    return app.request(`/tenants/${tenant}/datasets/${dataset}/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${as}`, 'change-reason': 'Laster%20opp%20veiledere' },
      body: form,
    });
  };
  await call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'kari', {
    method: 'PUT',
    body: {
      engine: 'typesense',
      baseURL: 'https://sok.testetaten.example.no',
      auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/search-token` },
    },
  });
  const created = await call(`/tenants/${digdir}/datasets`, 'kari', {
    body: {
      id: 'opplastet',
      name: 'Opplastede filer',
      residency: 'norway',
      index: { endpoint: 'sok', collections: { docs: 'filer_docs', chunks: 'filer_chunks' } },
    },
  });
  expect(created.status).toBe(201);
  return { platform, admin, app, call, upload, blobs };
};

const json = async <T>(response: Response) => (await response.json()) as T;
const base = `/tenants/${digdir}/datasets/opplastet`;

const settled = async (call: Awaited<ReturnType<typeof boot>>['call']) => {
  for (let i = 0; i < 100; i++) {
    const runs = await json<{ data: { status: string }[] }>(
      await call(`${base}/pipelines/filer/executions`, 'kari'),
    );
    if (runs.data[0] && runs.data[0].status !== 'running') return runs.data[0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the execution did not finish');
};

describe('uploading files to a dataset', () => {
  it('uploading and removing a file are admin tasks, and a refused upload stores nothing', async () => {
    const { call, upload, admin, blobs } = await boot();

    const stored = await upload('kari', [new File(['Hei'], 'notat.txt')]);
    const removed = await call(`${base}/uploads/notat.txt`, 'kari', { method: 'DELETE' });
    const refused = await upload('erik', [new File(['Hei'], 'skjult.txt')]);

    const audit = (await admin.audit(digdir))
      .filter((a) => a.action.startsWith('platform.dataset.upload'))
      .map((a) => [a.action, a.outcome, a.task]);
    expect(audit).toEqual([
      ['platform.dataset.upload', 'applied', stored.headers.get('genai-task')],
      ['platform.dataset.upload.delete', 'applied', removed.headers.get('genai-task')],
    ]);
    expect(refused.status).toBe(403);
    expect(await blobs.list(digdir, '')).toEqual([]);
  });

  it('stores the files, ingests them with an upload pipeline and shows the run on the dataset', async () => {
    const { call, upload, admin } = await boot();

    const sent = await upload('kari', [
      new File(['# Veileder\n\nSlik søker du tilskudd.'], 'Veileder for søknad.md'),
      new File(['%PDF-1.7'], 'notat.pdf', { type: 'application/pdf' }),
    ]);
    expect(sent.status).toBe(201);
    expect(await json(sent)).toEqual({
      uploaded: [
        { name: 'Veileder-for-søknad.md', size: 36, type: 'text/markdown' },
        { name: 'notat.pdf', size: 8, type: 'application/pdf' },
      ],
      skipped: [],
    });
    const listed = await json<{ data: { name: string; uploadedAt: string }[] }>(
      await call(`${base}/uploads`, 'kari'),
    );
    expect(listed.data.map((f) => f.name).sort()).toEqual(['Veileder-for-søknad.md', 'notat.pdf']);
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({
        action: 'platform.dataset.upload',
        reason: 'Laster opp veiledere',
      }),
    );

    const saved = await call(`${base}/pipelines`, 'kari', {
      body: {
        id: 'filer',
        name: 'Opplastede filer',
        source: { kind: 'upload' },
        chunking: { minimumLength: 1 },
      },
    });
    expect(saved.status).toBe(201);
    expect((await call(`${base}/pipelines/filer/execute`, 'kari', { body: {} })).status).toBe(202);
    expect(await settled(call)).toMatchObject({
      status: 'succeeded',
      report: { stored: 2, skipped: 0 },
    });

    const detail = await json<Record<string, unknown>>(await call(base, 'kari'));
    expect(detail).toMatchObject({
      id: 'opplastet',
      fullId: `${digdir}/opplastet`,
      source: 'upload',
      lastExecution: { status: 'succeeded', stored: 2, skipped: 0 },
      nextRunAt: null,
      skipped: [],
    });
    const list = await json<{ data: Record<string, unknown>[] }>(
      await call(`/tenants/${digdir}/datasets`, 'kari'),
    );
    expect(list.data.find((d) => d.id === 'opplastet')).toMatchObject({
      source: 'upload',
      lastExecution: { status: 'succeeded' },
    });
    expect(list.data.find((d) => d.id === 'opplastet')).not.toHaveProperty('skipped');

    const removed = await call(`${base}/uploads/notat.pdf`, 'kari', { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect(
      (await json<{ data: unknown[] }>(await call(`${base}/uploads`, 'kari'))).data,
    ).toHaveLength(1);
    expect((await call(`${base}/uploads/notat.pdf`, 'kari', { method: 'DELETE' })).status).toBe(
      404,
    );
  });

  it('refuses types it cannot read and files over the size limit, with a reason', async () => {
    const { upload, blobs } = await boot();

    const sent = await upload('kari', [
      new File(['png'], 'bilde.png', { type: 'image/png' }),
      new File(['x'.repeat(101)], 'stor.txt'),
      new File(['liten'], 'liten.txt'),
    ]);

    expect(sent.status).toBe(201);
    expect(await json(sent)).toEqual({
      uploaded: [{ name: 'liten.txt', size: 5, type: 'text/plain' }],
      skipped: [
        { name: 'bilde.png', reason: 'unsupported_type' },
        { name: 'stor.txt', reason: 'too_large' },
      ],
    });
    expect((await blobs.list(digdir)).map((b) => b.path)).toEqual([
      'datasets/opplastet/uploads/liten.txt',
    ]);
  });

  it('refuses a request with more files than the limit and stores none of them', async () => {
    const { upload, blobs } = await boot();

    const sent = await upload(
      'kari',
      ['a', 'b', 'c', 'd'].map((n) => new File(['tekst'], `${n}.txt`)),
    );

    expect(sent.status).toBe(413);
    expect(await json(sent)).toMatchObject({ status: 413, detail: expect.stringContaining('3') });
    expect(await blobs.list(digdir)).toEqual([]);
  });

  it('refuses a request body over the limit before reading the files', async () => {
    const { upload, blobs } = await boot();

    const sent = await upload('kari', [new File(['x'.repeat(5000)], 'stor.txt')]);

    expect(sent.status).toBe(413);
    expect(sent.headers.get('content-type')).toContain('application/problem+json');
    expect(await blobs.list(digdir)).toEqual([]);
  });

  it('checks the caller before reading an upload body, and refuses a declared oversize body at once', async () => {
    const { app } = await boot();
    let read = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.enqueue(new Uint8Array(5000));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const path = `/tenants/${digdir}/datasets/opplastet/uploads`;

    const anonymous = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body,
      duplex: 'half',
    } as RequestInit);
    const declared = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '5000' },
      body: 'x'.repeat(5000),
    });

    expect(anonymous.status).toBe(401);
    expect(read).toBe(false);
    expect(declared.status).toBe(413);
  });

  it('keeps another tenant and people without the dataset right out', async () => {
    const { call, upload, blobs } = await boot();
    const file = () => new File(['tekst'], 'notat.txt');

    expect((await upload('ola', [file()])).status).toBe(404);
    expect((await upload('ola', [file()], 'opplastet', other)).status).toBe(404);
    expect((await call(`${base}/uploads`, 'ola')).status).toBe(404);
    expect((await call(`/tenants/${other}/datasets/opplastet/uploads`, 'ola')).status).toBe(404);
    expect((await upload('erik', [file()])).status).toBe(403);
    expect(await blobs.list(digdir)).toEqual([]);
    expect(await blobs.list(other)).toEqual([]);
  });

  it('lets every member of the tenant list the uploaded files, like reading the dataset, but only people with the dataset right change them', async () => {
    const { call, upload } = await boot();
    await upload('kari', [new File(['tekst'], 'notat.txt')]);

    const listed = await call(`${base}/uploads`, 'erik');
    const removed = await call(`${base}/uploads/notat.txt`, 'erik', { method: 'DELETE' });

    expect(listed.status).toBe(200);
    expect(await json<{ data: { name: string }[] }>(listed)).toMatchObject({
      data: [{ name: 'notat.txt' }],
    });
    expect(removed.status).toBe(403);
  });

  it('keeps file names inside the upload folder', () => {
    expect(uploadName('../../hemmelig.pdf')).toBe('hemmelig.pdf');
    expect(uploadName('C:\\Users\\kari\\Årsrapport 2025 (endelig).docx')).toBe(
      'Årsrapport-2025-endelig.docx',
    );
    expect(uploadName('...')).toBeUndefined();
  });
});
