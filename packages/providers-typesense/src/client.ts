import { authHeaders, type Credential, withoutTrailingSlashes } from '@genai/kernel';
import { KnowledgeError } from '@genai/port-knowledge';

export const assertSearchOnly = (method: string, path: string) => {
  if (method !== 'POST' || path !== '/multi_search') {
    throw new KnowledgeError(
      'forbidden',
      `the Typesense client only searches; refused ${method} ${path}`,
    );
  }
};

export interface SearchOnlyClient {
  multiSearch(
    searches: Record<string, unknown>[],
    common: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const messageOf = (text: string) => {
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text;
  }
};

const statusError = (status: number, message: string) => {
  if (status === 429)
    return new KnowledgeError('rate_limited', 'the search engine is rate limited');
  if (status === 401 || status === 403)
    return new KnowledgeError('unauthorized', 'the search engine refused the key');
  if (status >= 400 && status < 500) return new KnowledgeError('bad_request', message);
  return new KnowledgeError('unavailable', 'the search engine is unavailable');
};

export const searchOnlyClient = (
  baseURL: string,
  credential: Credential,
  timeoutMs: number,
): SearchOnlyClient => {
  const base = withoutTrailingSlashes(baseURL);
  const request = async (
    method: string,
    path: string,
    query: Record<string, string>,
    body: unknown,
    signal: AbortSignal,
  ) => {
    assertSearchOnly(method, path);
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(await authHeaders(credential, 'x-typesense-api-key')),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    const text = await response.text();
    if (!response.ok) {
      const message = messageOf(text);
      throw statusError(response.status, message);
    }
    return JSON.parse(text) as unknown;
  };

  return {
    multiSearch: (searches, common, signal) =>
      request('POST', '/multi_search', common, { searches }, signal),
  };
};

const readOnlyPaths = [
  /^\/health$/,
  /^\/collections$/,
  /^\/collections\/[^/]+\/documents\/export$/,
  /^\/aliases\/[^/]+$/,
];

export const assertReadOnly = (method: string, path: string) => {
  if (method !== 'GET' || !readOnlyPaths.some((p) => p.test(path)))
    throw new KnowledgeError(
      'forbidden',
      `the Typesense reader only reads; refused ${method} ${path}`,
    );
};

export interface ReadOnlyClient {
  health(signal: AbortSignal): Promise<void>;
  collections(signal: AbortSignal): Promise<void>;
  /** The collection an alias points to, or undefined when the name is no alias. */
  alias(name: string, signal: AbortSignal): Promise<string | undefined>;
  /** Yields nothing when the collection does not exist. */
  exportDocuments(
    collection: string,
    query: Record<string, string>,
    signal: AbortSignal,
  ): AsyncIterable<Record<string, unknown>>;
}

async function* lines(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const part of body) {
    rest += decoder.decode(part, { stream: true });
    const split = rest.split('\n');
    rest = split.pop() ?? '';
    for (const line of split) if (line.trim()) yield line;
  }
  rest += decoder.decode();
  if (rest.trim()) yield rest;
}

export const readOnlyClient = (
  baseURL: string,
  credential: Credential,
  timeoutMs: number,
  send: typeof fetch = fetch,
): ReadOnlyClient => {
  const base = withoutTrailingSlashes(baseURL);
  const get = async (path: string, query: Record<string, string>, signal: AbortSignal) => {
    assertReadOnly('GET', path);
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers = new AbortController();
    const timer = setTimeout(
      () => headers.abort(new KnowledgeError('unavailable', 'the search engine did not answer')),
      timeoutMs,
    );
    try {
      return await send(url, {
        method: 'GET',
        headers: await authHeaders(credential, 'x-typesense-api-key'),
        signal: AbortSignal.any([signal, headers.signal]),
      });
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      if (headers.signal.aborted) throw headers.signal.reason;
      throw new KnowledgeError(
        'unavailable',
        `the search engine is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
  const ok = async (response: Response) => {
    const text = await response.text();
    if (!response.ok) throw statusError(response.status, messageOf(text));
    return text;
  };

  return {
    health: async (signal) => {
      const text = await ok(await get('/health', {}, signal));
      if ((JSON.parse(text) as { ok?: boolean }).ok !== true)
        throw new KnowledgeError('unavailable', 'the search engine is not ready');
    },
    collections: async (signal) => {
      await ok(await get('/collections', { limit: '1', exclude_fields: 'fields' }, signal));
    },
    alias: async (name, signal) => {
      const response = await get(`/aliases/${encodeURIComponent(name)}`, {}, signal);
      if (response.status === 404) return undefined;
      return (JSON.parse(await ok(response)) as { collection_name?: string }).collection_name;
    },
    async *exportDocuments(collection, query, signal) {
      const response = await get(
        `/collections/${encodeURIComponent(collection)}/documents/export`,
        query,
        signal,
      );
      if (response.status === 404) return;
      if (!response.ok || !response.body) {
        await ok(response);
        return;
      }
      for await (const line of lines(response.body))
        yield JSON.parse(line) as Record<string, unknown>;
    },
  };
};
