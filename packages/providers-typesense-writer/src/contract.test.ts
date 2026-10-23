import { randomUUID } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import {
  knowledgeProfiles,
  probeKnowledgeEndpoint,
  type IndexDocument,
} from '@genai/port-knowledge';
import {
  indexWriterContract,
  fixtureFilters,
  knowledgeAdapterContract,
  openTarget,
  seedCorpus,
  type ContractDataset,
  type KnowledgeTarget,
} from '@genai/port-knowledge/testing';
import {
  defaultTypesenseProfiles,
  provenanceCollection,
  typesense,
  typesenseDatasetOptions,
} from '@genai/providers-typesense';
import { collectionSchemas } from '@genai/providers-typesense/contract';
import { SharedClusterRefused, typesenseIndexWriter } from './index.js';

const image = 'typesense/typesense:30.2';
const apiKey = randomUUID();

const hostOf = (url: string) => new URL(url.includes('://') ? url : `https://${url}`).hostname;

let started: Promise<{ container: StartedTestContainer; baseURL: string }> | undefined;
const throwaway = () => {
  started ??= (async () => {
    const container = await new GenericContainer(image)
      .withCommand(['--data-dir', '/tmp', `--api-key=${apiKey}`])
      .withExposedPorts(8108)
      .withWaitStrategy(Wait.forHttp('/health', 8108).forStatusCode(200))
      .start();
    const baseURL = `http://${container.getHost()}:${container.getMappedPort(8108)}`;
    const shared = process.env.TYPESENSE_URL;
    if (shared && hostOf(shared) === hostOf(baseURL)) {
      await container.stop();
      throw new Error('refusing to run the contract against the configured TYPESENSE_URL host');
    }
    return { container, baseURL };
  })();
  return started;
};

beforeAll(async () => {
  await throwaway();
}, 180_000);

afterAll(async () => {
  if (started) await (await started).container.stop();
}, 60_000);

let datasets = 0;
const datasetOptions = () => {
  datasets += 1;
  const prefix = `contract_${datasets}_${randomUUID().slice(0, 8)}`;
  return {
    collections: {
      docs: `${prefix}_docs`,
      chunks: `${prefix}_chunks`,
      phrases: `${prefix}_phrases`,
    },
    writer: { embedPhrases: false },
    profiles: {
      [knowledgeProfiles.content]: {
        collection: 'chunks',
        queryBy: ['content_markdown'],
        textField: 'content_markdown',
      },
      [knowledgeProfiles.phrase]: {
        collection: 'phrases',
        queryBy: ['search_phrase'],
        textField: 'search_phrase',
      },
      [knowledgeProfiles.docTitle]: { collection: 'docs', queryBy: ['title'], textField: 'title' },
    },
  };
};

const connect = async (dataset: ContractDataset) => {
  const { baseURL } = await throwaway();
  const options = datasetOptions();
  const config = {
    ...dataset,
    options: typesenseDatasetOptions.parse(options),
  };
  const writer = typesenseIndexWriter().connect(
    {
      baseURL,
      credential: { kind: 'api-key', key: async () => apiKey },
      options: {},
      timeoutMs: 30_000,
    },
    { signal: new AbortController().signal },
  );
  const target: KnowledgeTarget = {
    adapter: typesense,
    endpoint: { baseURL, auth: { kind: 'api-key', secret: 'secret://env/contract-key' } },
    datasetOptions: options,
    secrets: envSecrets({ CONTRACT_KEY: apiKey }),
    failingRequest: { query: 'tilskudd', filters: { aar: { gte: 'ikke-et-tall' } } },
  };
  return { target, writer, config };
};

knowledgeAdapterContract('typesense', async ({ dataset }) => {
  const { target, writer, config } = await connect(dataset);
  await seedCorpus(writer, config);
  return target;
});

indexWriterContract('typesense', async ({ dataset }) => {
  const { target, writer, config } = await connect(dataset);
  return { ...target, writer, dataset: config };
});

describe('typesense index writer', () => {
  const credential = { kind: 'api-key' as const, key: async () => 'unused' };
  const signal = new AbortController().signal;

  it('lets the reader name the generation the aliases serve after each promote', async () => {
    const { baseURL } = await throwaway();
    const { writer, config } = await connect({ id: 'contract/served', filters: fixtureFilters });
    const reader = typesense.connect({
      baseURL,
      credential: { kind: 'api-key', key: async () => apiKey },
      options: {},
      timeoutMs: 30_000,
    });

    await seedCorpus(writer, config, undefined, 'g1');
    expect((await reader.served?.(config as never, signal))?.generation).toBe('g1');
    await seedCorpus(writer, config, undefined, 'g2');
    expect(await reader.served?.(config as never, signal)).toEqual({
      generation: 'g2',
      collections: Object.values((config.options as { collections: object }).collections),
    });
  });

  it('refuses the shared search-only host before sending anything', () => {
    let requests = 0;
    const adapter = typesenseIndexWriter({
      sharedClusterUrls: ['https://search.example.no:443'],
      fetch: async () => {
        requests += 1;
        return new Response('{}');
      },
    });
    expect(() =>
      adapter.connect(
        { baseURL: 'http://SEARCH.example.no:8108', credential, options: {}, timeoutMs: 1000 },
        { signal },
      ),
    ).toThrow(SharedClusterRefused);
    expect(requests).toBe(0);
  });

  it('refuses the host in TYPESENSE_URL by default', () => {
    const before = process.env.TYPESENSE_URL;
    process.env.TYPESENSE_URL = 'https://shared.example.no';
    try {
      expect(() =>
        typesenseIndexWriter().connect(
          { baseURL: 'https://shared.example.no:8108', credential, options: {}, timeoutMs: 1000 },
          { signal },
        ),
      ).toThrow(expect.objectContaining({ code: 'forbidden' }));
    } finally {
      if (before === undefined) delete process.env.TYPESENSE_URL;
      else process.env.TYPESENSE_URL = before;
    }
  });

  it('probe succeeds on a reachable endpoint and fails clearly otherwise', async () => {
    const { baseURL } = await throwaway();
    const probe = (key: string) =>
      probeKnowledgeEndpoint(
        { engine: 'typesense', baseURL, auth: { kind: 'api-key', secret: 'secret://env/probe' } },
        { adapters: [typesense], secrets: envSecrets({ PROBE: key }) },
      );
    expect(await probe(apiKey)).toMatchObject({ ok: true, engine: 'typesense' });
    expect(await probe('feil-nokkel')).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('needs no vectors, since Typesense embeds phrases itself', () => {
    expect(typesenseIndexWriter()).toMatchObject({
      engine: 'typesense',
      needs: { vectors: false },
    });
  });

  it('serves titles and urls joined from the docs alias after promote', async () => {
    const dataset = { id: 'contract/joined', filters: fixtureFilters };
    const { target, writer, config } = await connect(dataset);
    await seedCorpus(writer, config);
    const [hit] = await openTarget(target, dataset).fetch(['dok-2-1']);
    expect(hit).toMatchObject({
      id: 'dok-2-1',
      document: 'dok-2',
      position: 1,
      title: 'Årsrapport for tilskudd 2021',
      url: 'https://example.no/dok-2',
    });
  });

  it('exports dedicated provenance through the read-only Typesense port without trusting user columns', async () => {
    const dataset = { id: 'contract/provenance-export', filters: fixtureFilters };
    const { target, writer, config } = await connect(dataset);
    const document = {
      id: 'a',
      pipeline: 'actual-owner',
      fields: { ingestion_pipeline: 'user-owner', pipeline: 'user-column' },
      chunks: [{ id: 'a0', position: 0, text: 'Tilskudd til lag.' }],
      phrases: [],
    };
    await writer.prepare(config, 'g1');
    await writer.store(config, 'g1', document);
    await writer.promote(config, 'g1');
    const exporter = openTarget(target, dataset).export;
    if (!exporter) throw new Error('Typesense needs document export');
    const docs = [];
    for await (const doc of exporter.documents()) docs.push(doc);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.pipeline).toBe('actual-owner');
    expect(docs[0]?.fields).toMatchObject({
      ingestion_pipeline: 'user-owner',
      pipeline: 'user-column',
    });
    const unattributed: IndexDocument = { ...document };
    delete unattributed.pipeline;
    await writer.store(config, 'g1', unattributed);
    for await (const doc of exporter.documents()) expect(doc.pipeline).toBeUndefined();
  });

  it('legacy Typesense exports without a provenance collection never infer ownership from user metadata', async () => {
    const { baseURL } = await throwaway();
    const dataset = { id: 'contract/legacy-provenance', filters: fixtureFilters };
    const { target, writer, config } = await connect(dataset);
    await writer.prepare(config, 'old');
    await writer.store(config, 'old', {
      id: 'a',
      fields: { ingestion_pipeline: 'b', pipeline: 'user-column' },
      chunks: [],
      phrases: [],
    });
    await writer.promote(config, 'old');
    const docsName = `${config.options.collections.docs}__old`;
    const deleted = await fetch(`${baseURL}/collections/${provenanceCollection(docsName)}`, {
      method: 'DELETE',
      headers: { 'x-typesense-api-key': apiKey },
    });
    expect(deleted.ok).toBe(true);
    const exporter = openTarget(target, dataset).export;
    if (!exporter) throw new Error('Typesense needs document export');
    const docs = [];
    for await (const doc of exporter.documents()) docs.push(doc);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.pipeline).toBeUndefined();
    expect(docs[0]?.fields).toMatchObject({ ingestion_pipeline: 'b', pipeline: 'user-column' });
  });

  it('creates the headless-rag KA collections for the kudos preset', async () => {
    const { baseURL } = await throwaway();
    const prefix = `kudos_${randomUUID().slice(0, 8)}`;
    const names = {
      docs: `${prefix}_docs`,
      chunks: `${prefix}_chunks`,
      phrases: `${prefix}_phrases`,
    };
    const options = typesenseDatasetOptions.parse({
      collections: names,
      writer: { schemas: 'kudos', embedPhrases: false },
      profiles: defaultTypesenseProfiles,
    });
    const writer = typesenseIndexWriter().connect(
      {
        baseURL,
        credential: { kind: 'api-key', key: async () => apiKey },
        options: {},
        timeoutMs: 30_000,
      },
      { signal },
    );
    await writer.prepare({ id: 'digdir/kudos', filters: {}, options }, 'g1');
    const fields = async (name: string) => {
      const response = await fetch(`${baseURL}/collections/${name}__g1`, {
        headers: { 'x-typesense-api-key': apiKey },
      });
      return ((await response.json()) as { fields: { name: string }[] }).fields.map((f) => f.name);
    };
    const ka = collectionSchemas(names);
    expect(await fields(names.docs)).toEqual(ka.docs.fields.map((f) => f.name));
    expect(await fields(names.chunks)).toEqual(ka.chunks.fields.map((f) => f.name));
    expect(await fields(names.phrases)).toEqual(
      ka.phrases.fields.filter((f) => f.embed === undefined).map((f) => f.name),
    );
  });
});
