import { describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import {
  IndexWriterRouter,
  KnowledgeError,
  KnowledgeRouter,
  localKnowledgeAdapter,
  probeKnowledgeEndpoint,
  type IndexDocument,
  type KnowledgeAdapter,
} from './index.js';
import { fixtureDocuments, memoryEngine, seedCorpus } from './testing/index.js';

const catalog = {
  endpoints: {
    local: { engine: 'memory' },
    remote: {
      engine: 'other',
      baseURL: 'https://s.example',
      auth: { kind: 'bearer', secret: 'secret://env/k' },
    },
  },
  datasets: [
    {
      id: 'digdir/veiledere',
      aliases: ['veiledere'],
      endpoint: 'local',
      residency: 'norway',
      embedding: { model: 'fixture', dimensions: 8 },
    },
    { id: 'nav/fjern', endpoint: 'remote', residency: 'norway' },
  ],
};

describe('index writer router', () => {
  const engine = memoryEngine({ vectors: true });
  const other = { ...memoryEngine().adapter, engine: 'other', requiresBaseURL: true };
  const writers = new IndexWriterRouter({
    catalog,
    adapters: [engine.writer],
    knowledgeAdapters: [engine.adapter, other],
    secrets: envSecrets({}),
  });
  const signal = new AbortController().signal;

  it('opens the writer of the dataset engine by id or alias', async () => {
    const route = writers.open('veiledere', { signal });
    expect(route).toMatchObject({
      engine: 'memory',
      needs: { vectors: true },
      dataset: { id: 'digdir/veiledere', embedding: { dimensions: 8 } },
    });
    await route.writer.prepare(route.dataset, 'g1');
    await route.writer.store(route.dataset, 'g1', fixtureDocuments[0] as never);
    expect(await route.writer.stats(route.dataset, 'g1')).toMatchObject({ documents: 1 });
    expect(writers.engines()).toEqual(['memory']);
  });

  it('refuses a dataset whose engine has no writer and an unknown dataset', () => {
    expect(writers.supports('nav/fjern')).toBe(false);
    expect(() => writers.open('nav/fjern', { signal })).toThrow(/no index writer for engine other/);
    expect(() => writers.open('finnes/ikke', { signal })).toThrow(/no dataset/);
  });

  it('lets an adapter supply default dataset options', () => {
    expect(engine.adapter.defaults?.({ filters: {}, options: {} })).toMatchObject({
      profiles: { content: { mode: 'text' }, 'doc-title': { mode: 'text' } },
    });
    expect(engine.adapter.defaults?.({ filters: {}, options: { profiles: {} } })).toEqual({});
  });
});

describe('engine switch seams', () => {
  const signal = new AbortController().signal;
  const context = {
    tenant: '991825827',
    principal: { kind: 'employee' as const, issuer: 'test', subject: 'kari', tenant: '991825827' },
    task: 't1',
    signal,
    meter: async () => undefined,
  };
  const twoEngines = () => {
    const current = memoryEngine();
    const next = memoryEngine({ engine: 'memory-next', vectors: true });
    const switching = {
      endpoints: { local: { engine: 'memory' }, next: { engine: 'memory-next' } },
      datasets: [
        { id: 'digdir/veiledere', aliases: ['veiledere'], endpoint: 'local', residency: 'norway' },
      ],
    };
    const options = {
      catalog: switching,
      knowledgeAdapters: [current.adapter, next.adapter],
      secrets: envSecrets({}),
    };
    return {
      writers: new IndexWriterRouter({ ...options, adapters: [current.writer, next.writer] }),
      readers: new KnowledgeRouter({ ...options, adapters: options.knowledgeAdapters }),
    };
  };
  const [first, second] = fixtureDocuments as [IndexDocument, IndexDocument];
  const ref = { kind: 'dataset' as const, id: 'veiledere' };
  const documents = async (port: ReturnType<KnowledgeRouter['open']>) =>
    (await port.search({ query: 'tilskudd', limit: 50 })).hits.map((h) => h.document);

  it('openAt writes a generation the catalog route does not read', async () => {
    const { writers, readers } = twoEngines();
    const current = writers.open('veiledere', { signal });
    await seedCorpus(current.writer, current.dataset, [first]);

    const target = writers.openAt('veiledere', 'next', { signal });
    expect(target).toMatchObject({
      engine: 'memory-next',
      endpoint: 'next',
      dataset: { id: 'digdir/veiledere' },
    });
    await seedCorpus(target.writer, target.dataset, [second]);

    expect(new Set(await documents(readers.open(ref, context)))).toEqual(new Set([first.id]));
    const moved = readers.openAt(ref, 'next', context);
    expect(moved.info()).toMatchObject({ id: 'digdir/veiledere', engine: 'memory-next' });
    expect(new Set(await documents(moved))).toEqual(new Set([second.id]));
    expect(readers.open(ref, context).info().engine).toBe('memory');
  });

  it('openAt applies option overrides and refuses unknown endpoints and bad options', () => {
    const { writers, readers } = twoEngines();
    const embedding = { model: 'ny-modell', dimensions: 16 };
    const route = writers.openAt(
      'veiledere',
      'next',
      { signal },
      {
        datasetOptions: { index: 'kopi' },
        embedding,
      },
    );
    expect(route.dataset).toMatchObject({ options: { index: 'kopi' }, embedding });
    expect(readers.openAt(ref, 'next', context, { embedding }).info().capabilities).toContain(
      'search.hybrid',
    );
    expect(() => writers.openAt('veiledere', 'finnes-ikke', { signal })).toThrow(/no endpoint/);
    expect(() =>
      writers.openAt('veiledere', 'next', { signal }, { datasetOptions: { ukjent: true } }),
    ).toThrow(KnowledgeError);
    expect(() => readers.openAt({ ...ref, id: 'finnes/ikke' }, 'next', context)).toThrow(
      /no dataset/,
    );
  });

  it('a forced drop through another endpoint of the same engine spares the served generation', async () => {
    const shared = memoryEngine();
    const writers = new IndexWriterRouter({
      catalog: {
        endpoints: { local: { engine: 'memory' }, copy: { engine: 'memory' } },
        datasets: [{ id: 'digdir/veiledere', endpoint: 'local', residency: 'norway' }],
      },
      adapters: [shared.writer],
      knowledgeAdapters: [shared.adapter],
      secrets: envSecrets({}),
    });
    const served = writers.open('digdir/veiledere', { signal });
    await seedCorpus(served.writer, served.dataset, [first]);
    const other = writers.openAt('digdir/veiledere', 'copy', { signal });
    await expect(other.writer.drop(other.dataset, 'g1', { force: true })).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('serves'),
    });
    expect(await served.writer.active(served.dataset)).toBe('g1');
  });

  it('a forced drop removes the active generation of an endpoint the catalog no longer serves', async () => {
    const { writers } = twoEngines();
    const target = writers.openAt('veiledere', 'next', { signal });
    await seedCorpus(target.writer, target.dataset, [second]);
    await expect(target.writer.drop(target.dataset, 'g1')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await target.writer.drop(target.dataset, 'g1', { force: true });
    expect(await target.writer.active(target.dataset)).toBeUndefined();
  });

  it('probe succeeds on a reachable endpoint and fails clearly otherwise', async () => {
    const { readers } = twoEngines();
    expect(await readers.probe('local')).toMatchObject({ ok: true, engine: 'memory' });
    expect(await readers.probe('finnes-ikke')).toMatchObject({ ok: false, code: 'bad_request' });

    const failing = localKnowledgeAdapter({
      ...memoryEngine({ engine: 'nede' }).adapter,
      connect: memoryEngine().adapter.connect,
      probe: async () => {
        throw new KnowledgeError('unavailable', 'connection refused');
      },
    });
    const hanging = localKnowledgeAdapter({
      ...memoryEngine({ engine: 'treg' }).adapter,
      connect: memoryEngine().adapter.connect,
      probe: () => new Promise<void>(() => undefined),
    });
    const silent: KnowledgeAdapter = { ...memoryEngine({ engine: 'stille' }).adapter };
    delete silent.probe;
    const options = {
      adapters: [failing, hanging, silent] as KnowledgeAdapter[],
      secrets: envSecrets({}),
      timeoutMs: 50,
    };
    expect(await probeKnowledgeEndpoint({ engine: 'nede' }, options)).toMatchObject({
      ok: false,
      engine: 'nede',
      code: 'unavailable',
      message: 'connection refused',
    });
    expect(await probeKnowledgeEndpoint({ engine: 'treg' }, options)).toMatchObject({
      ok: false,
      code: 'unavailable',
      message: 'the connection test timed out',
    });
    expect(await probeKnowledgeEndpoint({ engine: 'stille' }, options)).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
    expect(await probeKnowledgeEndpoint({ engine: 'ukjent' }, options)).toMatchObject({
      ok: false,
      code: 'bad_request',
      message: expect.stringContaining('no adapter for ukjent'),
    });
  });
});
