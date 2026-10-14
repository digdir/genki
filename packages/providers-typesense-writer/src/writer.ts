import { authHeaders, type Credential, withoutTrailingSlashes } from '@genai/kernel';
import { KnowledgeError } from '@genai/port-knowledge';
import folder from './schemas/folder.json' with { type: 'json' };
import website from './schemas/website.json' with { type: 'json' };

export interface RawSchema {
  fields: { name: string; reference?: string; embed?: unknown; [key: string]: unknown }[];
  [key: string]: unknown;
}

export interface ContractSchemas {
  docs: RawSchema;
  chunks: RawSchema;
  phrases: RawSchema;
}

export interface CollectionNames {
  docs: string;
  chunks: string;
  phrases: string;
}

export interface TypesenseWriterOptions {
  baseURL: string;
  credential: Credential;
  schemas: ContractSchemas;
  sharedClusterUrls?: (string | undefined)[];
  embeddings?: boolean;
  batchSize?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export class SharedClusterRefused extends KnowledgeError {
  constructor(host: string) {
    super(
      'forbidden',
      `refusing to write to ${host}: it is the shared, search-only Typesense cluster`,
    );
    this.name = 'SharedClusterRefused';
  }
}

const hostOf = (url: string) => new URL(url).hostname.toLowerCase().replace(/\.$/, '');

const safeHost = (url: string | undefined) => {
  if (!url) return undefined;
  try {
    return hostOf(url.includes('://') ? url : `https://${url}`);
  } catch {
    return undefined;
  }
};

export const refuseSharedCluster = (
  baseURL: string,
  sharedClusterUrls: (string | undefined)[] = [process.env.TYPESENSE_URL],
) => {
  const host = hostOf(baseURL);
  if (sharedClusterUrls.map(safeHost).includes(host)) throw new SharedClusterRefused(host);
  return host;
};

export interface TypesenseHttpOptions {
  baseURL: string;
  credential: Credential;
  timeoutMs?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export const typesenseHttp = (options: TypesenseHttpOptions) => {
  const base = withoutTrailingSlashes(options.baseURL);
  const send = options.fetch ?? fetch;

  const request = async (
    method: string,
    path: string,
    body?: string,
    contentType = 'application/json',
  ) => {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const response = await send(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': contentType }),
        ...(await authHeaders(options.credential, 'x-typesense-api-key')),
      },
      ...(body === undefined ? {} : { body }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  };

  const json = async (method: string, path: string, payload?: unknown) => {
    const result = await request(
      method,
      path,
      payload === undefined ? undefined : JSON.stringify(payload),
    );
    if (!result.ok)
      throw new Error(
        `Typesense ${method} ${path} answered HTTP ${result.status}: ${result.text.slice(0, 300)}`,
      );
    return result.text ? (JSON.parse(result.text) as unknown) : undefined;
  };

  return { request, json };
};

const plainId = /^[A-Za-z0-9_-]+$/;

const requireIds = (values: string[]) => {
  for (const v of values)
    if (!plainId.test(v))
      throw new Error(`refusing an id that is not plain letters, digits, _ or -: ${v}`);
  return values;
};

export const forCollections = (
  raw: RawSchema,
  name: string,
  docs: string,
  embeddings: boolean,
) => ({
  ...structuredClone(raw),
  name,
  fields: raw.fields
    .filter((f) => embeddings || f.embed === undefined)
    .map((f) =>
      f.reference ? { ...f, reference: f.reference.replace('{docs}', docs) } : { ...f },
    ),
});

export const generationNames = (names: CollectionNames, generation: string): CollectionNames => {
  requireIds([generation]);
  return {
    docs: `${names.docs}__${generation}`,
    chunks: `${names.chunks}__${generation}`,
    phrases: `${names.phrases}__${generation}`,
  };
};

export const createTypesenseWriter = (options: TypesenseWriterOptions) => {
  const host = refuseSharedCluster(options.baseURL, options.sharedClusterUrls);
  const batchSize = options.batchSize ?? 200;
  const embeddings = options.embeddings ?? true;
  const { request, json } = typesenseHttp(options);

  const exists = async (name: string) => {
    const result = await request('GET', `/collections/${encodeURIComponent(name)}`);
    if (result.status === 404) return false;
    if (!result.ok)
      throw new Error(`Typesense GET /collections/${name} answered HTTP ${result.status}`);
    return true;
  };

  const ensureCollections = async (names: CollectionNames) => {
    for (const [kind, name] of [
      ['docs', names.docs],
      ['chunks', names.chunks],
      ['phrases', names.phrases],
    ] as const) {
      if (await exists(name)) continue;
      await json(
        'POST',
        '/collections',
        forCollections(options.schemas[kind], name, names.docs, embeddings),
      );
    }
  };

  const upsert = async (collection: string, documents: Record<string, unknown>[]) => {
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      const result = await request(
        'POST',
        `/collections/${encodeURIComponent(collection)}/documents/import?action=upsert`,
        batch.map((d) => JSON.stringify(d)).join('\n'),
        'text/plain',
      );
      if (!result.ok)
        throw new Error(`Typesense import into ${collection} answered HTTP ${result.status}`);
      const failed = result.text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { success: boolean; error?: string })
        .find((line) => !line.success);
      if (failed)
        throw new Error(
          `Typesense refused a document in ${collection}: ${failed.error ?? 'unknown error'}`,
        );
    }
  };

  const deleteOrphans = async (collection: string, docNum: string, keep: string[]) => {
    if (keep.length === 0 || docNum.trim() === '') return;
    requireIds([docNum, ...keep]);
    const filter = `doc_num:=${docNum} && id:!=[${keep.join(',')}]`;
    await json(
      'DELETE',
      `/collections/${encodeURIComponent(collection)}/documents?filter_by=${encodeURIComponent(filter)}`,
    );
  };

  return {
    host,
    ensureCollections,
    upsert,
    deleteOrphans,

    storeDocument: async (
      names: CollectionNames,
      docNum: string,
      doc: Record<string, unknown>,
      chunks: Record<string, unknown>[],
      phrases: { id: string }[],
    ) => {
      await upsert(names.docs, [doc]);
      await upsert(names.chunks, chunks);
      await deleteOrphans(
        names.chunks,
        docNum,
        chunks.map((c) => String(c.id)),
      );
      await upsert(names.phrases, phrases as unknown as Record<string, unknown>[]);
      await deleteOrphans(
        names.phrases,
        docNum,
        phrases.map((p) => p.id),
      );
    },

    retrieve: async (collection: string, id: string) =>
      json(
        'GET',
        `/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(requireIds([id])[0] as string)}`,
      ),

    promote: async (aliases: CollectionNames, target: CollectionNames) => {
      const previous: Partial<CollectionNames> = {};
      for (const kind of ['docs', 'chunks', 'phrases'] as const) {
        const current = await request('GET', `/aliases/${encodeURIComponent(aliases[kind])}`);
        if (current.ok)
          previous[kind] = (
            JSON.parse(current.text) as { collection_name: string }
          ).collection_name;
        await json('PUT', `/aliases/${encodeURIComponent(aliases[kind])}`, {
          collection_name: target[kind],
        });
      }
      return previous;
    },

    dropCollections: async (names: Partial<CollectionNames>) => {
      for (const name of [names.phrases, names.chunks, names.docs])
        if (name) await json('DELETE', `/collections/${encodeURIComponent(name)}`);
    },
  };
};

export type TypesenseWriter = ReturnType<typeof createTypesenseWriter>;

export const websiteSchemas = website as ContractSchemas;
export const folderSchemas = folder as ContractSchemas;
