import {
  KnowledgeError,
  kindsOf,
  type DatasetConfig,
  type FieldFilter,
  type IndexDocument,
  type IndexStats,
  type IndexWriter,
  type IndexWriterAdapter,
  type LocalEndpointConfig,
} from '@genai/port-knowledge';
import { collectionSchemas } from '@genai/providers-typesense/contract';
import {
  generationSeparator as separator,
  readOnlyClient,
  readTypesenseDocuments,
  typesense,
  typesenseDatasetOptions,
  type TypesenseDatasetOptions,
} from '@genai/providers-typesense';
import {
  createTypesenseWriter,
  folderSchemas,
  forCollections,
  refuseSharedCluster,
  typesenseHttp,
  websiteSchemas,
  type ContractSchemas,
} from './writer.js';
import { typesenseEnrichment } from './enrichment.js';

type Dataset = DatasetConfig<TypesenseDatasetOptions>;
type Kind = 'docs' | 'chunks' | 'phrases';

const kinds: Kind[] = ['docs', 'chunks', 'phrases'];

export interface TypesenseIndexWriterOptions {
  sharedClusterUrls?: (string | undefined)[];
  batchSize?: number;
  fetch?: typeof fetch;
}

const generationPattern = /^[A-Za-z0-9_-]+$/;

const requireGeneration = (generation: string) => {
  if (!generationPattern.test(generation))
    throw new KnowledgeError(
      'bad_request',
      `a generation is plain letters, digits, _ or -: ${generation}`,
    );
  return generation;
};

const literal = (value: string) => {
  if (value.includes('`'))
    throw new KnowledgeError('bad_request', `refusing an id with a backtick: ${value}`);
  return `\`${value}\``;
};

const fieldType = (filter: FieldFilter) => {
  const k = kindsOf(filter);
  if (k.includes('boolean')) return 'bool';
  if (k.includes('range')) return k.includes('multiselect') ? 'float[]' : 'float';
  return k.includes('multiselect') ? 'string[]' : 'string';
};

const kudosSchemas = (): ContractSchemas =>
  collectionSchemas({ docs: '{docs}', chunks: 'chunks', phrases: 'phrases' });

export const derivedSchemas = (dataset: Dataset): ContractSchemas => {
  const { fields } = dataset.options;
  const reference = {
    name: fields.document,
    type: 'string',
    facet: true,
    reference: `{docs}.${fields.document}`,
  };
  return {
    docs: {
      fields: [
        { name: fields.document, type: 'string', facet: true, sort: true },
        { name: fields.title, type: 'string', optional: true },
        { name: fields.url, type: 'string', optional: true },
        { name: 'total_chunks', type: 'int32', optional: true },
        ...Object.entries(dataset.filters)
          .filter(([name]) => ![fields.document, fields.title, fields.url].includes(name))
          .map(([name, filter]) => ({
            name,
            type: fieldType(filter),
            optional: true,
            facet: kindsOf(filter).some((k) => k === 'select' || k === 'multiselect'),
          })),
      ],
    },
    chunks: {
      fields: [
        { name: fields.id, type: 'string', facet: true, sort: true },
        reference,
        { name: fields.position, type: 'int32', sort: true },
        { name: fields.text, type: 'string', locale: 'no' },
        { name: 'metadata', type: 'string', optional: true, locale: 'no' },
        { name: 'content_length', type: 'int32', optional: true },
      ],
    },
    phrases: {
      fields: [
        { name: fields.id, type: 'string', facet: true },
        reference,
        { name: 'search_phrase', type: 'string' },
        {
          name: 'phrase_vec',
          type: 'float[]',
          embed: { from: ['search_phrase'], model_config: { model_name: 'ts/all-MiniLM-L12-v2' } },
          optional: true,
        },
      ],
    },
  };
};

const schemasFor = (dataset: Dataset): ContractSchemas => {
  const preset = dataset.options.writer?.schemas ?? 'derived';
  if (preset === 'kudos') return kudosSchemas();
  if (preset === 'website') return websiteSchemas;
  if (preset === 'folder') return folderSchemas;
  return derivedSchemas(dataset);
};

const records = (dataset: Dataset, doc: IndexDocument) => {
  const { fields } = dataset.options;
  const multiselect = Object.entries(dataset.filters)
    .filter(([, f]) => kindsOf(f).includes('multiselect'))
    .map(([name]) => name);
  const docFields = Object.fromEntries(
    Object.entries(doc.fields).map(([name, value]) => [
      name,
      multiselect.includes(name) && value !== null && !Array.isArray(value) ? [value] : value,
    ]),
  );
  return {
    docs: {
      total_chunks: doc.chunks.length,
      ...docFields,
      id: doc.id,
      [fields.document]: doc.id,
      ...(doc.title === undefined ? {} : { [fields.title]: doc.title }),
      ...(doc.url === undefined ? {} : { [fields.url]: doc.url }),
    },
    chunks: doc.chunks.map((c) => ({
      content_length: c.text.length,
      ...c.metadata,
      id: c.id,
      [fields.id]: c.id,
      [fields.document]: doc.id,
      [fields.position]: c.position,
      [fields.text]: c.text,
    })),
    phrases: doc.phrases.map((p) => ({
      id: p.id,
      [fields.id]: p.chunkId,
      [fields.document]: doc.id,
      search_phrase: p.text,
    })),
  };
};

export const typesenseIndexWriter = (
  options: TypesenseIndexWriterOptions = {},
): IndexWriterAdapter<Record<string, never>, TypesenseDatasetOptions> => ({
  engine: typesense.engine,
  needs: { vectors: false },
  endpointOptions: typesense.endpointOptions,
  datasetOptions: typesenseDatasetOptions,

  connect(
    endpoint: LocalEndpointConfig<Record<string, never>>,
    context,
  ): IndexWriter<TypesenseDatasetOptions> {
    const { baseURL, credential } = endpoint;
    if (!baseURL || !credential)
      throw new KnowledgeError('bad_request', 'a Typesense endpoint needs a baseURL and auth');
    refuseSharedCluster(baseURL, options.sharedClusterUrls);
    const shared = { baseURL, credential, timeoutMs: endpoint.timeoutMs, signal: context.signal };
    const { request, json } = typesenseHttp({
      ...shared,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    const reader = readOnlyClient(baseURL, credential, endpoint.timeoutMs, options.fetch);
    const importer = (dataset: Dataset) =>
      createTypesenseWriter({
        ...shared,
        schemas: schemasFor(dataset),
        sharedClusterUrls: options.sharedClusterUrls ?? [process.env.TYPESENSE_URL],
        ...(options.batchSize ? { batchSize: options.batchSize } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });

    const aliases = (dataset: Dataset) =>
      kinds.flatMap((kind) => {
        const alias = dataset.options.collections[kind];
        return alias ? [{ kind, alias }] : [];
      });
    const named = (dataset: Dataset, generation: string) =>
      aliases(dataset).map(({ kind, alias }) => ({
        kind,
        alias,
        name: `${alias}${separator}${requireGeneration(generation)}`,
      }));
    const nameOf = (dataset: Dataset, generation: string, kind: Kind) =>
      named(dataset, generation).find((n) => n.kind === kind)?.name;
    const docsAlias = (dataset: Dataset) => dataset.options.collections.docs as string;

    const collection = async (name: string) => {
      const result = await request('GET', `/collections/${encodeURIComponent(name)}`);
      if (result.status === 404) return undefined;
      if (!result.ok)
        throw new Error(`Typesense GET /collections/${name} answered HTTP ${result.status}`);
      return JSON.parse(result.text) as { num_documents?: number };
    };

    const active = async (dataset: Dataset) => {
      const result = await request('GET', `/aliases/${encodeURIComponent(docsAlias(dataset))}`);
      if (result.status === 404) return undefined;
      if (!result.ok)
        throw new Error(
          `Typesense GET /aliases/${docsAlias(dataset)} answered HTTP ${result.status}`,
        );
      const target = (JSON.parse(result.text) as { collection_name: string }).collection_name;
      const prefix = `${docsAlias(dataset)}${separator}`;
      return target.startsWith(prefix) ? target.slice(prefix.length) : undefined;
    };

    const removeOrphans = async (
      dataset: Dataset,
      name: string | undefined,
      docId: string,
      keep: string[],
    ) => {
      if (!name) return;
      const document = `${dataset.options.fields.document}:=${literal(docId)}`;
      const filter = keep.length
        ? `${document} && id:!=[${keep.map(literal).join(',')}]`
        : document;
      await json(
        'DELETE',
        `/collections/${encodeURIComponent(name)}/documents?filter_by=${encodeURIComponent(filter)}`,
      );
    };

    return {
      preservesPipeline: false,
      ...{
        enrichment: typesenseEnrichment(
          { request, json },
          baseURL,
          options.sharedClusterUrls ?? [process.env.TYPESENSE_URL],
        ),
      },
      prepare: async (dataset, generation) => {
        const schemas = schemasFor(dataset);
        const embed = dataset.options.writer?.embedPhrases ?? true;
        const all = named(dataset, generation);
        const docs = all.find((n) => n.kind === 'docs')?.name as string;
        for (const { kind, name } of all) {
          if (await collection(name)) continue;
          await json('POST', '/collections', forCollections(schemas[kind], name, docs, embed));
        }
      },

      store: async (dataset, generation, doc) => {
        const writer = importer(dataset);
        const record = records(dataset, doc);
        const chunks = nameOf(dataset, generation, 'chunks') as string;
        const phrases = nameOf(dataset, generation, 'phrases');
        await writer.upsert(nameOf(dataset, generation, 'docs') as string, [record.docs]);
        await writer.upsert(chunks, record.chunks);
        await removeOrphans(
          dataset,
          chunks,
          doc.id,
          record.chunks.map((c) => c.id),
        );
        if (phrases) {
          await writer.upsert(phrases, record.phrases);
          await removeOrphans(
            dataset,
            phrases,
            doc.id,
            record.phrases.map((p) => p.id),
          );
        }
      },

      promote: async (dataset, generation) => {
        const target = named(dataset, generation);
        for (const { name } of target)
          if (!(await collection(name)))
            throw new KnowledgeError('bad_request', `generation ${generation} is not prepared`);
        const previous = await active(dataset);
        for (const { alias, name } of target)
          await json('PUT', `/aliases/${encodeURIComponent(alias)}`, { collection_name: name });
        return previous;
      },

      drop: async (dataset, generation, options = {}) => {
        if ((await active(dataset)) === requireGeneration(generation)) {
          if (!options.force)
            throw new KnowledgeError(
              'bad_request',
              `generation ${generation} of ${dataset.id} is active; promote another first`,
            );
          for (const { alias } of named(dataset, generation)) {
            const result = await request('DELETE', `/aliases/${encodeURIComponent(alias)}`);
            if (!result.ok && result.status !== 404)
              throw new Error(`Typesense DELETE /aliases/${alias} answered HTTP ${result.status}`);
          }
        }
        for (const { name } of named(dataset, generation).reverse()) {
          const result = await request('DELETE', `/collections/${encodeURIComponent(name)}`);
          if (!result.ok && result.status !== 404)
            throw new Error(`Typesense DELETE /collections/${name} answered HTTP ${result.status}`);
        }
      },

      active,

      read: (dataset, generation) =>
        (async function* () {
          const chosen = generation ?? (await active(dataset));
          if (chosen === undefined) return;
          const docs = nameOf(dataset, chosen, 'docs') as string;
          if (!(await collection(docs)))
            throw new KnowledgeError('bad_request', `generation ${chosen} is not prepared`);
          const phrases = nameOf(dataset, chosen, 'phrases');
          yield* readTypesenseDocuments(
            reader,
            dataset,
            {
              docs,
              chunks: nameOf(dataset, chosen, 'chunks') as string,
              ...(phrases ? { phrases } : {}),
            },
            context.signal,
          );
        })(),

      stats: async (dataset, generation): Promise<IndexStats> => {
        const count = async (kind: Kind) => {
          const name = nameOf(dataset, generation, kind);
          return name ? ((await collection(name))?.num_documents ?? 0) : 0;
        };
        return {
          documents: await count('docs'),
          chunks: await count('chunks'),
          phrases: await count('phrases'),
        };
      },
    };
  },
});
