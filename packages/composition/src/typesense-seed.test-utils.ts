/**
 * The shipped seed puts Kudos and public-docs on the knowledge server, which these tests do not
 * run. Tests that search them move them to a Typesense endpoint of their own, at a fake Typesense,
 * with the collections and search profiles the shared Typesense server had (#690).
 */
const textParams = {
  sort_by: '_text_match:desc',
  prioritize_exact_match: false,
  drop_tokens_threshold: 5,
};

const typesenseOptions = (
  prefix: string,
  docFields: string[],
  extra: Record<string, unknown> = {},
) => ({
  collections: {
    docs: `${prefix}_documents_ab897fbdedfa`,
    chunks: `${prefix}_chunks_ab897fbdedfa`,
    phrases: `${prefix}_phrases_ab897fbdedfa`,
  },
  docFields,
  ...extra,
  profiles: {
    phrase: {
      collection: 'phrases',
      queryBy: ['search_phrase', 'phrase_vec'],
      textField: 'search_phrase',
      include: ['chunk_id', 'search_phrase', 'doc_num'],
      exclude: ['phrase_vec'],
      score: 'fusion',
      params: textParams,
    },
    metadata: {
      collection: 'chunks',
      queryBy: ['metadata'],
      textField: 'metadata',
      include: ['chunk_id', 'metadata'],
      params: textParams,
    },
    content: {
      collection: 'chunks',
      queryBy: ['content_markdown'],
      textField: 'content_markdown',
      include: ['chunk_id', 'content_markdown'],
      params: textParams,
    },
    'doc-title': {
      collection: 'docs',
      queryBy: ['title'],
      textField: 'title',
      include: ['doc_num', 'total_chunks', 'title'],
      params: textParams,
    },
  },
});

const onTypesense: Record<string, Record<string, unknown>> = {
  'digdir/kudos': typesenseOptions(
    'KUDOS_preprod_v4',
    [
      'url',
      'title',
      'total_chunks',
      'orgs_long',
      'orgs_short',
      'file_sha256',
      'files',
      'publish_date',
    ],
    { maxFacetValues: 1000 },
  ),
  'digdir/public-docs': typesenseOptions('website', ['url', 'title', 'total_chunks']),
};

/** The id of the Typesense endpoint `seedOnTypesense` adds. */
export const typesenseTestEndpoint = 'typesense-test';

/**
 * The knowledge seed with Kudos and public-docs on a Typesense endpoint at `baseURL`, by default
 * the test's own `TYPESENSE_URL`, read with the env secret `TYPESENSE_KEY`.
 */
export const seedOnTypesense = (seed: unknown, baseURL = '${TYPESENSE_URL}'): unknown => {
  const catalog = seed as { endpoints?: Record<string, unknown>; datasets?: { id: string }[] };
  return {
    ...catalog,
    endpoints: {
      ...catalog.endpoints,
      [typesenseTestEndpoint]: {
        engine: 'typesense',
        baseURL,
        auth: { kind: 'api-key', secret: 'secret://env/typesense-key' },
      },
    },
    datasets: (catalog.datasets ?? []).map((dataset) =>
      onTypesense[dataset.id]
        ? { ...dataset, endpoint: typesenseTestEndpoint, options: onTypesense[dataset.id] }
        : dataset,
    ),
  };
};
