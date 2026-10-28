import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import {
  apiKeyDigest,
  createAuthenticator,
  InMemoryApiKeys,
  type StoredApiKey,
} from '@genai/identity';
import type { Event } from '@genai/contracts';
import { envSecrets, InMemoryEventLog, InMemoryTaskStore } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import { runDocumentsFolder } from '@genai/jobs';
import {
  deleteConversationDocuments,
  runtimeDocumentStore,
  runtimeDocumentTypes,
} from './runtime-documents.js';
import { digdir, files, klarsprak } from './testkit.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const key = (id: string, extra: Partial<StoredApiKey> = {}): StoredApiKey => ({
  id,
  name: id,
  digest: apiKeyDigest(`gp_${id}`),
  tenant: digdir,
  scopes: ['query'],
  datasets: [],
  agents: [],
  ...extra,
});

const boot = async () => {
  const model = await fakeHttp(() => ({
    status: 200,
    json: {
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Enklere tekst.' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  }));
  servers.push(model);
  const keys = new InMemoryApiKeys();
  keys.add(key('frontend', { service: 'klarsprak' }));
  keys.add(key('other', { service: 'tekstsjekk' }));
  const authenticator = createAuthenticator({ apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
  const blobs = new InMemoryBlobStore();
  const log = new InMemoryEventLog();
  const tasks = new InMemoryTaskStore();
  const platform = await createPlatform({
    blobStore: blobs,
    log,
    tasks,
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: model.url,
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [{ id: 'fake/gpt', endpoint: 'fake', deployment: 'gpt', residency: 'norway' }],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  for (const [id, knowledge] of [
    ['klarsprak', { datasets: [], runtimeDocuments: true }],
    ['tekstsjekk', { datasets: [] }],
  ] as const) {
    const definition = klarsprak({ id });
    await platform.definitions.publish(
      {
        ...definition,
        spec: {
          ...definition.spec,
          input: { accepts: ['text/plain', 'text/markdown', 'application/pdf'] },
          knowledge,
          exposure: { rest: true, chat: true },
          model: { primary: 'fake/gpt', residency: 'norway' },
        },
      },
      'test',
      'test',
      files,
    );
  }
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      auth: { authenticate: async () => undefined },
      tenantGate: platform.tenantGate,
    },
  });
  platform.mount(app, admin);
  const send = (path: string, keyId: string, body?: unknown, method?: string) =>
    app.request(path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        'x-api-key': `gp_${keyId}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { send, model, blobs, log, tasks };
};

const encoded = (text: string) => Buffer.from(text, 'utf8').toString('base64');

const ask = (documents: unknown) => ({
  model: 'klarsprak__default',
  messages: [{ role: 'user', content: 'Hva er fristen i brevet?' }],
  genai_documents: documents,
});

describe('documents an employee attaches to a question', () => {
  it('offers only text types it can read, and only when the service takes runtime documents', () => {
    expect(
      runtimeDocumentTypes({
        knowledge: { runtimeDocuments: true },
        input: { accepts: ['text/plain', 'application/pdf', 'text/markdown; charset=utf-8'] },
      }),
    ).toEqual(['text/plain', 'text/markdown']);
    expect(runtimeDocumentTypes({ input: { accepts: ['text/plain'] } })).toEqual([]);
  });

  it('lists the document types and limits in /v1/models for a service that takes documents', async () => {
    const { send } = await boot();
    const body = (await (await send('/v1/models', 'frontend')).json()) as {
      data: { id: string; _documents?: unknown }[];
    };
    const other = (await (await send('/v1/models', 'other')).json()) as {
      data: { _documents?: unknown }[];
    };

    expect(body.data.find((m) => m.id === 'klarsprak__default')?._documents).toEqual({
      accepts: ['text/plain', 'text/markdown'],
      max_bytes: 2 * 1024 * 1024,
      max_count: 5,
    });
    expect(other.data.every((m) => m._documents === undefined)).toBe(true);
  });

  it('stores an attached document in the caller’s own organisation and gives its text to the model', async () => {
    const { send, model, blobs } = await boot();
    const response = await send(
      '/v1/chat/completions',
      'frontend',
      ask([
        { name: '../brev.md', media_type: 'text/markdown', data: encoded('Fristen er 1. mars.') },
      ]),
    );

    expect(response.status).toBe(200);
    expect(JSON.stringify(model.seen.at(-1)?.body)).toContain('Fristen er 1. mars.');
    const stored = await blobs.list(digdir, runDocumentsFolder);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.path).toMatch(
      /^run-documents\/991825827\.klarsprak\.[^/]+\/[^/]+\/brev\.md$/,
    );
    expect(await blobs.list('987654321', runDocumentsFolder)).toEqual([]);
  });

  it('refuses documents to a service that does not take them, of a wrong type, too large or not text', async () => {
    const { send, blobs } = await boot();
    const refused = await send('/v1/chat/completions', 'other', {
      ...ask([{ name: 'a.txt', media_type: 'text/plain', data: encoded('x') }]),
      model: 'tekstsjekk__default',
    });
    const pdf = await send(
      '/v1/chat/completions',
      'frontend',
      ask([{ name: 'a.pdf', media_type: 'application/pdf', data: encoded('%PDF') }]),
    );
    const large = await send(
      '/v1/chat/completions',
      'frontend',
      ask([
        { name: 'a.txt', media_type: 'text/plain', data: encoded('x'.repeat(2 * 1024 * 1024 + 1)) },
      ]),
    );
    const binary = await send(
      '/v1/chat/completions',
      'frontend',
      ask([
        {
          name: 'a.txt',
          media_type: 'text/plain',
          data: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'),
        },
      ]),
    );

    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'documents_not_accepted',
    );
    expect([pdf.status, large.status, binary.status]).toEqual([415, 413, 415]);
    expect(await blobs.list(digdir, runDocumentsFolder)).toEqual([]);
  });

  const converse = async (send: Awaited<ReturnType<typeof boot>>['send'], text: string) => {
    const response = await send('/v1/chat/completions', 'frontend', {
      ...ask([{ name: 'brev.txt', media_type: 'text/plain', data: encoded(text) }]),
      genai_conversation: true,
    });
    const body = (await response.json()) as { conversation_id: string };
    expect({ status: response.status, body }).toMatchObject({ status: 200 });
    return body.conversation_id;
  };

  it('deleting a conversation deletes its uploaded documents', async () => {
    const { send, blobs } = await boot();
    const id = await converse(send, 'Fristen er 1. mars.');
    expect(await blobs.list(digdir, runDocumentsFolder)).toHaveLength(1);

    const deleted = await send(`/api/conversations/${id}`, 'frontend', undefined, 'DELETE');

    expect(deleted.status).toBe(200);
    expect(await blobs.list(digdir, runDocumentsFolder)).toEqual([]);
  });

  it('deleting a conversation erases the task events of its turns, but not other conversations', async () => {
    const { send, log, tasks } = await boot();
    const gone = await converse(send, 'Fristen er 1. mars.');
    const kept = await converse(send, 'Fristen er 2. april.');
    const inputOf = async (thread: string) => {
      const task = tasks.all().find((t) => t.task.thread === thread)?.task;
      const events: Event[] = [];
      for await (const e of log.read(task?.id ?? '', 0, () => false)) events.push(e);
      return events.find((e) => e.type === 'kernel.task.input')?.data;
    };
    expect(JSON.stringify(await inputOf(gone))).toContain('Fristen er 1. mars.');

    await send(`/api/conversations/${gone}`, 'frontend', undefined, 'DELETE');

    expect(await inputOf(gone)).toEqual({ erased: true });
    expect(JSON.stringify(await inputOf(kept))).toContain('Fristen er 2. april.');
  });

  it('deleting a conversation leaves other conversations’ documents alone', async () => {
    const { send, blobs } = await boot();
    const gone = await converse(send, 'Fristen er 1. mars.');
    const kept = await converse(send, 'Fristen er 2. april.');
    await send(
      '/v1/chat/completions',
      'frontend',
      ask([{ name: 'løs.txt', media_type: 'text/plain', data: encoded('Uten samtale.') }]),
    );
    await blobs.put(
      { tenant: '987654321', path: `${runDocumentsFolder}/x/conversations/c-${gone}/a/b.txt` },
      new TextEncoder().encode('annen virksomhet'),
      'text/plain',
    );

    await send(`/api/conversations/${gone}`, 'frontend', undefined, 'DELETE');

    const left = (await blobs.list(digdir, runDocumentsFolder)).map((b) => b.path);
    expect(left).toHaveLength(2);
    expect(left.filter((p) => p.includes(`/conversations/c-${kept}/`))).toHaveLength(1);
    expect(left.some((p) => p.includes(gone))).toBe(false);
    expect(await blobs.list('987654321', runDocumentsFolder)).toHaveLength(1);
  });

  it('stores and deletes the documents of a conversation whose id starts with a dash or underscore', async () => {
    const blobs = new InMemoryBlobStore();
    const documents = runtimeDocumentStore(blobs);
    const principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'kari',
      tenant: digdir,
    } as const;
    const body = new TextEncoder().encode('Fristen er 1. mars.');
    for (const id of ['-a1', '_b2'])
      await documents.store(
        principal,
        [{ name: 'brev.txt', mediaType: 'text/plain', body }],
        `${digdir}/klarsprak/default`,
        id,
      );

    expect(await deleteConversationDocuments(blobs, digdir, '-a1')).toBe(1);
    expect(await blobs.list(digdir, runDocumentsFolder)).toEqual([
      expect.objectContaining({ path: expect.stringContaining('/conversations/c-_b2/') }),
    ]);
  });
});
