import {
  clauseFits,
  filterKinds,
  KnowledgeError,
  kindsOf,
  knowledgeProfiles,
  type DatasetConfig,
  type DatasetDraft,
  type FacetValue,
  type FieldFilter,
  type FilterClause,
  type FilterKind,
  type FilterValue,
  type Hit,
  type KnowledgeAdapter,
  type KnowledgeCapability,
  type KnowledgeEndpointConfig,
  type SearchRequest,
  type SearchResult,
} from '@genai/port-knowledge';
import { z } from 'zod';
import { readOnlyClient, searchOnlyClient } from './client.js';
import { readTypesenseDocuments } from './reader.js';

export { assertReadOnly, assertSearchOnly, readOnlyClient, type ReadOnlyClient } from './client.js';
export { readTypesenseDocuments, type ReadCollections } from './reader.js';

const fieldName = z.string().regex(/^[A-Za-z0-9_.]+$/);
const reservedParams = new Set([
  'collection',
  'q',
  'query_by',
  'filter_by',
  'include_fields',
  'exclude_fields',
  'per_page',
]);

const param = z.union([z.string(), z.number(), z.boolean()]);

const profile = z.strictObject({
  collection: z.string().regex(/^[a-z][a-z0-9-]*$/),
  queryBy: z.array(fieldName).min(1),
  textField: fieldName,
  include: z.array(fieldName).default([]),
  exclude: z.array(fieldName).default([]),
  score: z
    .enum(['text', 'fusion'])
    .meta({ enumTitles: ['Ordsøk', 'Kombinert søk'] })
    .default('text'),
  params: z
    .record(z.string(), param)
    .refine((params) => !Object.keys(params).some((key) => reservedParams.has(key)), {
      message: `params cannot set ${[...reservedParams].join(', ')}`,
    })
    .default({}),
});

const datasetOptions = z
  .strictObject({
    collections: z
      .record(z.string().regex(/^[a-z][a-z0-9-]*$/), fieldName)
      .refine((c) => Boolean(c.docs && c.chunks), 'docs and chunks collections are required'),
    fields: z
      .strictObject({
        id: fieldName.default('chunk_id'),
        document: fieldName.default('doc_num'),
        position: fieldName.default('chunk_index'),
        text: fieldName.default('content_markdown'),
        title: fieldName.default('title'),
        url: fieldName.default('url'),
      })
      .prefault({}),
    chunkFields: z
      .array(fieldName)
      .default([
        'id',
        'chunk_id',
        'doc_num',
        'chunk_index',
        'content_markdown',
        'content_length',
        'metadata',
      ]),
    docFields: z.array(fieldName).default(['url', 'title', 'total_chunks']),
    facetQueryBy: fieldName.default('title'),
    maxFacetValues: z.number().int().positive().max(1000).default(500),
    profiles: z
      .record(z.string(), profile)
      .refine((p) => Object.keys(p).length > 0, 'at least one profile'),
    writer: z
      .strictObject({
        schemas: z
          .enum(['derived', 'kudos', 'website', 'folder'])
          .meta({
            enumTitles: ['Utledet fra datasettet', 'Kunnskapsassistenten', 'Nettsted', 'Mappe'],
          })
          .default('derived'),
        embedPhrases: z.boolean().default(true),
      })
      .optional(),
  })
  .superRefine((options, ctx) => {
    for (const [name, p] of Object.entries(options.profiles)) {
      if (!options.collections[p.collection])
        ctx.addIssue({
          code: 'custom',
          path: ['profiles', name, 'collection'],
          message: `unknown collection ${p.collection}`,
        });
    }
  });

export type TypesenseDatasetOptions = z.infer<typeof datasetOptions>;
type Options = TypesenseDatasetOptions;
type Profile = z.infer<typeof profile>;
type Dataset = DatasetConfig<Options>;

export const typesenseDatasetOptions = datasetOptions;

export const defaultTypesenseProfiles = {
  [knowledgeProfiles.content]: {
    collection: 'chunks',
    queryBy: ['content_markdown'],
    textField: 'content_markdown',
    include: ['chunk_id', 'content_markdown'],
  },
};

// A fusion score only exists when Typesense ran a hybrid text and vector query.
const capabilitiesOf = (dataset: Dataset): KnowledgeCapability[] => [
  'search.text',
  ...(Object.values(dataset.options.profiles).some((p) => p.score === 'fusion')
    ? (['search.hybrid'] as const)
    : []),
  'fetch',
  'range',
  'facets',
  ...filterKinds.map((k) => `filter.${k}` as const),
];

const defaultsFor = (draft: DatasetDraft): Record<string, unknown> => {
  const collections = draft.options.collections as Record<string, unknown> | undefined;
  return !draft.options.profiles && collections?.chunks
    ? { profiles: structuredClone(defaultTypesenseProfiles) }
    : {};
};

const unsafe = (value: string) =>
  [...value].some(
    (c) => c === '`' || c === '\\' || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  );

const literal = (value: string | number) => {
  if (typeof value === 'number') return String(value);
  if (unsafe(value))
    throw new KnowledgeError(
      'bad_request',
      'filter values cannot contain backticks, backslashes or control characters',
    );
  return `\`${value}\``;
};

const containsLiteral = (value: string) => (/^\d+$/.test(value) ? value : literal(value));

const exactLiteral = (value: string | number) =>
  typeof value === 'string' && /^\d{1,15}$/.test(value) ? value : literal(value);

const clause = (field: string, kind: FilterKind, value: FilterClause): string => {
  if (typeof value === 'boolean') return `${field}:=${value}`;
  if (Array.isArray(value)) return `${field}:=[${value.map(exactLiteral).join(',')}]`;
  if (typeof value === 'string' || typeof value === 'number')
    return kind === 'text'
      ? `${field}:${typeof value === 'string' ? containsLiteral(value) : value}`
      : `${field}:=${kind === 'multiselect' ? `[${exactLiteral(value)}]` : exactLiteral(value)}`;
  if ('not' in value) return `${field}:!=[${value.not.map(exactLiteral).join(',')}]`;
  if ('contains' in value) {
    const parts = value.contains.map((v) => `${field}:${containsLiteral(v)}`);
    return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' || ')})`;
  }
  return [
    ...(value.gte === undefined ? [] : [`${field}:>=${literal(value.gte)}`]),
    ...(value.lte === undefined ? [] : [`${field}:<=${literal(value.lte)}`]),
  ].join(' && ');
};

const fieldClause = (field: string, declared: FieldFilter, value: FilterClause) => {
  const kind =
    kindsOf(declared).find((k) => clauseFits(k, value)) ?? kindsOf(declared)[0] ?? 'select';
  return clause(field, kind, value);
};

const filterBy = (
  dataset: Dataset,
  filters: Record<string, FilterValue> = {},
  collection = 'docs',
) => {
  const clauses = Object.entries(filters).flatMap(([field, value]) => {
    const declared = dataset.filters[field] ?? 'select';
    const parts =
      typeof value === 'object' && value !== null && !Array.isArray(value) && 'all' in value
        ? value.all
        : [value];
    return parts.map((part) => fieldClause(field, declared, part));
  });
  if (clauses.length === 0) return undefined;
  const expression = clauses.join(' && ');
  return collection === 'docs' ? expression : `$${docsOf(dataset)}(${expression})`;
};

export const generationSeparator = '__';

const docsOf = (dataset: Dataset) => dataset.options.collections.docs as string;
const chunksOf = (dataset: Dataset) => dataset.options.collections.chunks as string;

const collectionName = (dataset: Dataset, collection: string) => {
  const name = dataset.options.collections[collection];
  if (!name)
    throw new KnowledgeError(
      'bad_request',
      `dataset ${dataset.id} has no ${collection} collection`,
    );
  return name;
};

interface TypesenseHit {
  document: Record<string, unknown>;
  text_match_info?: { score?: string | number };
  hybrid_search_info?: { rank_fusion_score?: number };
}

interface TypesenseResult {
  hits?: TypesenseHit[];
  found?: number;
  facet_counts?: { field_name: string; counts: { value: string; count: number }[] }[];
  code?: number;
  error?: string;
}

const str = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

const toHit = (
  dataset: Dataset,
  hit: TypesenseHit,
  textField: string,
  score: Profile['score'],
  collection: string,
): Hit => {
  const { fields } = dataset.options;
  const doc = hit.document;
  const joined = (doc[docsOf(dataset)] ?? {}) as Record<string, unknown>;
  const document = str(doc[fields.document]);
  const position = doc[fields.position];
  const title = str(doc[fields.title] ?? joined[fields.title]);
  const url = str(doc[fields.url] ?? joined[fields.url]);
  const raw =
    score === 'fusion' ? hit.hybrid_search_info?.rank_fusion_score : hit.text_match_info?.score;
  return {
    id: (collection === 'docs' ? document : str(doc[fields.id])) ?? '',
    score: Number(raw ?? 0),
    text: str(doc[textField]) ?? '',
    ...(title === undefined ? {} : { title }),
    ...(url === undefined ? {} : { url }),
    ...(document === undefined ? {} : { document }),
    ...(typeof position === 'number' ? { position } : {}),
    fields: doc,
  };
};

const resultsOf = (response: unknown): TypesenseResult[] => {
  const results = (response as { results?: TypesenseResult[] }).results;
  if (!Array.isArray(results))
    throw new KnowledgeError('unavailable', 'unexpected response from the search engine');
  return results;
};

const failed = (result: TypesenseResult) => result.code !== undefined && result.code !== 200;

export const typesense: KnowledgeAdapter<Record<string, never>, Options> = {
  engine: 'typesense',
  title: 'Typesense',
  tech: 'Typesense',
  endpointOptions: z.strictObject({}),
  datasetOptions,
  capabilities: capabilitiesOf,
  defaults: defaultsFor,

  async probe(endpoint: KnowledgeEndpointConfig, signal: AbortSignal) {
    const client = readOnlyClient(endpoint.baseURL, endpoint.credential, endpoint.timeoutMs);
    await client.health(signal);
    await client.collections(signal);
  },

  connect(endpoint: KnowledgeEndpointConfig) {
    const client = searchOnlyClient(endpoint.baseURL, endpoint.credential, endpoint.timeoutMs);

    const chunkInclude = (dataset: Dataset) =>
      [
        ...dataset.options.chunkFields,
        `$${docsOf(dataset)}(${dataset.options.docFields.join(',')})`,
      ].join(',');

    const single = async (search: Record<string, unknown>, signal: AbortSignal) => {
      const [result] = resultsOf(await client.multiSearch([search], {}, signal));
      if (!result || failed(result))
        throw new KnowledgeError('bad_request', result?.error ?? 'the search failed');
      return result;
    };

    const reader = readOnlyClient(endpoint.baseURL, endpoint.credential, 30_000);
    return {
      export: {
        vectors: false,
        documents: (dataset: Dataset, signal: AbortSignal) => {
          const { docs, chunks, phrases } = dataset.options.collections;
          return readTypesenseDocuments(
            reader,
            dataset,
            {
              docs: docs as string,
              chunks: chunks as string,
              ...(phrases ? { phrases } : {}),
            },
            signal,
          );
        },
        count: async (dataset: Dataset, cap: number, signal: AbortSignal) => {
          let n = 0;
          for await (const _ of reader.exportDocuments(
            docsOf(dataset),
            { include_fields: 'id' },
            signal,
          )) {
            void _;
            n += 1;
            if (n >= cap) break;
          }
          return n;
        },
      },
      served: async (dataset: Dataset, signal: AbortSignal) => {
        const collections = [...new Set(Object.values(dataset.options.collections))];
        if (!dataset.options.writer) return { collections };
        const docs = docsOf(dataset);
        const target = await reader.alias(docs, signal);
        const prefix = `${docs}${generationSeparator}`;
        return target?.startsWith(prefix)
          ? { generation: target.slice(prefix.length), collections }
          : { collections };
      },
      profiles: (dataset: Dataset) => Object.keys(dataset.options.profiles),

      search: async (dataset: Dataset, requests: SearchRequest[], signal) => {
        const plans = requests.map((r) => {
          const p = dataset.options.profiles[r.profile ?? ''];
          if (!p)
            throw new KnowledgeError(
              'bad_request',
              `dataset ${dataset.id} has no search profile ${r.profile}`,
            );
          const filter = filterBy(dataset, r.filters, p.collection);
          return {
            profile: p,
            body: {
              ...p.params,
              collection: collectionName(dataset, p.collection),
              q: r.query,
              query_by: p.queryBy.join(','),
              ...(p.include.length ? { include_fields: p.include.join(',') } : {}),
              ...(p.exclude.length ? { exclude_fields: p.exclude.join(',') } : {}),
              per_page: r.limit ?? 10,
              ...(filter ? { filter_by: filter } : {}),
            },
          };
        });
        const results = resultsOf(
          await client.multiSearch(
            plans.map((p) => p.body),
            {},
            signal,
          ),
        );
        return plans.map((plan, i): SearchResult => {
          const result = results[i];
          if (!result || failed(result))
            return { hits: [], warning: result?.error ?? 'the search failed' };
          return {
            hits: (result.hits ?? []).map((h) =>
              toHit(
                dataset,
                h,
                plan.profile.textField,
                plan.profile.score,
                plan.profile.collection,
              ),
            ),
            ...(result.found === undefined ? {} : { found: result.found }),
          };
        });
      },

      fetch: async (dataset: Dataset, ids, signal) => {
        const { fields } = dataset.options;
        const result = await single(
          {
            collection: chunksOf(dataset),
            q: '*',
            query_by: fields.id,
            filter_by: `${fields.id}:=[${ids.map(literal).join(',')}]`,
            per_page: ids.length,
            include_fields: chunkInclude(dataset),
          },
          signal,
        );
        const hits = (result.hits ?? []).map((h) =>
          toHit(dataset, h, fields.text, 'text', 'chunks'),
        );
        const byId = new Map(hits.map((h) => [h.id, h]));
        return ids.flatMap((id) => byId.get(id) ?? []);
      },

      range: async (dataset: Dataset, document, from, to, signal) => {
        const { fields } = dataset.options;
        const result = await single(
          {
            collection: chunksOf(dataset),
            q: '*',
            query_by: fields.id,
            filter_by: `${fields.document}:=${literal(document)} && ${fields.position}:>=${from} && ${fields.position}:<=${to}`,
            sort_by: `${fields.position}:asc`,
            per_page: to - from + 1,
            include_fields: chunkInclude(dataset),
          },
          signal,
        );
        return (result.hits ?? []).map((h) => toHit(dataset, h, fields.text, 'text', 'chunks'));
      },

      documents: async (dataset: Dataset, request, signal) => {
        const { fields } = dataset.options;
        const filters = [
          ...(request.ids?.length
            ? [`${fields.document}:=[${request.ids.map(literal).join(',')}]`]
            : []),
          ...[filterBy(dataset, request.filters, 'docs')].filter((f): f is string => Boolean(f)),
        ];
        const limit = request.limit ?? 100;
        const offset = request.offset ?? 0;
        const result = await single(
          {
            collection: docsOf(dataset),
            q: '*',
            query_by: dataset.options.facetQueryBy,
            per_page: limit,
            page: Math.floor(offset / limit) + 1,
            ...(filters.length ? { filter_by: filters.join(' && ') } : {}),
          },
          signal,
        );
        return {
          documents: (result.hits ?? []).map((h) => {
            const hit = toHit(dataset, h, fields.text, 'text', 'docs');
            return {
              id: hit.id || (str(h.document.id) ?? ''),
              ...(hit.title === undefined ? {} : { title: hit.title }),
              ...(hit.url === undefined ? {} : { url: hit.url }),
              fields: h.document,
            };
          }),
          ...(result.found === undefined ? {} : { found: result.found }),
        };
      },

      facets: async (
        dataset: Dataset,
        facetFields,
        filters,
        signal,
      ): Promise<Record<string, FacetValue[]>> => {
        const filter = filterBy(dataset, filters, 'docs');
        const result = await single(
          {
            collection: docsOf(dataset),
            q: '*',
            query_by: dataset.options.facetQueryBy,
            facet_by: facetFields.join(','),
            per_page: 0,
            max_facet_values: dataset.options.maxFacetValues,
            ...(filter ? { filter_by: filter } : {}),
          },
          signal,
        );
        return Object.fromEntries(
          facetFields.map((f) => [
            f,
            (result.facet_counts?.find((c) => c.field_name === f)?.counts ?? []).map((c) => ({
              value: c.value,
              count: c.count,
            })),
          ]),
        );
      },
    };
  },
};
