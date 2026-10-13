import { parseEdn } from './edn.js';
import { send } from './http.js';
import type { Attributor, StageAttribution, StageHit } from './quality.js';
import type { JsonValue, Target } from './types.js';

export interface RetrieveRequest {
  queries: string[];
  rerank?: boolean;
  autoFilter?: boolean;
  topK?: number;
}

export interface RetrievedHit extends StageHit {
  score?: number;
}

export interface FixedRetrieval {
  chunks: RetrievedHit[];
  ms: number;
  detectedFilter?: JsonValue;
  rerank?: string;
}

export type Retriever = (request: RetrieveRequest) => Promise<FixedRetrieval>;

export interface OperatorAccess {
  baseUrl: string;
  token: string;
  supportSession: string;
  tenant: string;
}

export interface DebugAccess {
  baseUrl: string;
  debugKey: string;
}

type Obj = Record<string, JsonValue>;

const obj = (v: JsonValue | string | undefined): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;

const text = (v: JsonValue | undefined) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

const hitOf = (raw: JsonValue): RetrievedHit[] => {
  const c = obj(raw);
  const chunkId = text(c?.chunkId ?? c?.chunk_id ?? c?.['chunk-id'] ?? c?.id);
  if (!chunkId) return [];
  const document = text(c?.document ?? c?.doc_num ?? c?.['doc-num']);
  const position = c?.position ?? c?.chunk_index ?? c?.['chunk-index'];
  const score = c?.score ?? c?.['rerank-score'];
  return [
    {
      chunkId,
      ...(document ? { document } : {}),
      ...(typeof position === 'number' ? { position } : {}),
      ...(typeof score === 'number' ? { score } : {}),
    },
  ];
};

const hits = (v: JsonValue | undefined) => (Array.isArray(v) ? v.flatMap(hitOf) : []);

const operatorTarget = (access: OperatorAccess): Target => ({
  name: 'new-operator',
  baseUrl: access.baseUrl,
});

const operatorHeaders = (access: OperatorAccess) => ({
  authorization: `Bearer ${access.token}`,
  'support-session': access.supportSession,
});

const failure = (what: string, status: number, body: JsonValue | string | undefined) => {
  const detail = obj(body)?.title ?? obj(body)?.error ?? (typeof body === 'string' ? body : '');
  return new Error(
    `${what} answered HTTP ${status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`,
  );
};

export const platformRetriever =
  (access: OperatorAccess, scope: { service?: string; dataset?: string }): Retriever =>
  async (request) => {
    const started = Date.now();
    const response = await send(operatorTarget(access), {
      method: 'POST',
      path: `/tenants/${encodeURIComponent(access.tenant)}/diagnostics/retrieve`,
      auth: false,
      headers: operatorHeaders(access),
      body: {
        ...scope,
        queries: request.queries,
        overrides: {
          ...(request.rerank === undefined ? {} : { rerank: request.rerank }),
          ...(request.autoFilter === undefined ? {} : { autoFilter: request.autoFilter }),
          ...(request.topK === undefined ? {} : { retrieveTopK: request.topK }),
        },
      },
    });
    const ms = Date.now() - started;
    if (response.status !== 200)
      throw failure('diagnostics/retrieve', response.status, response.body);
    const body = obj(response.body);
    const expansion = obj(obj(body?.trace)?.expansion);
    const detected = expansion?.detectedFilter;
    const rerank = text(obj(expansion?.rerank)?.status);
    return {
      chunks: hits(body?.chunks),
      ms,
      ...(detected === undefined ? {} : { detectedFilter: detected }),
      ...(rerank ? { rerank } : {}),
    };
  };

export const headlessRetriever =
  (access: DebugAccess, scope: { tenant: string; datasetConfigKey: string }): Retriever =>
  async (request) => {
    const query = new URLSearchParams({
      tenant: scope.tenant,
      'dataset-config-key': scope.datasetConfigKey,
      ...(request.queries.length === 1
        ? { q: request.queries[0] as string }
        : { queries: request.queries.map((q) => q.replaceAll(',', ' ')).join(',') }),
      ...(request.rerank === undefined ? {} : { 'rerank-with-colbert': String(request.rerank) }),
      ...(request.autoFilter === undefined ? {} : { 'auto-filter': String(request.autoFilter) }),
      ...(request.topK === undefined ? {} : { 'retrieve-top-k': String(request.topK) }),
    });
    const started = Date.now();
    const response = await fetch(
      new URL(`/api/debug/typesense-retrieve?${query}`, access.baseUrl),
      {
        headers: { 'x-debug-api-key': access.debugKey },
      },
    );
    const ms = Date.now() - started;
    const raw = await response.text();
    let body: JsonValue | string;
    try {
      body = parseEdn(raw);
    } catch {
      body = raw;
    }
    if (response.status !== 200)
      throw failure('/api/debug/typesense-retrieve', response.status, body);
    const parsed = obj(body);
    const attribution = obj(parsed?.['search-attribution']);
    const detected = attribution?.['auto-filter-applied'];
    return {
      chunks: hits(parsed?.chunks),
      ms,
      ...(detected === undefined ? {} : { detectedFilter: detected }),
    };
  };

export const parseAttribution = (body: JsonValue | string | undefined): StageAttribution => {
  const b = obj(body);
  return { pool: hits(b?.pool), displayed: hits(b?.displayed), read: hits(b?.read) };
};

export const platformAttributor =
  (access: OperatorAccess, newTarget: string): Attributor =>
  async (target, run) => {
    if (target.name !== newTarget || !run.task) return undefined;
    const response = await send(operatorTarget(access), {
      method: 'GET',
      path: `/tenants/${encodeURIComponent(access.tenant)}/diagnostics/tasks/${encodeURIComponent(run.task)}/attribution`,
      auth: false,
      headers: operatorHeaders(access),
    });
    if (response.status !== 200)
      throw failure('diagnostics/attribution', response.status, response.body);
    return parseAttribution(response.body);
  };

export const operatorAccessFromEnv = (
  env: Record<string, string | undefined>,
): OperatorAccess | undefined => {
  const token = env.PARITY_NEW_OPERATOR_TOKEN;
  const supportSession = env.PARITY_NEW_SUPPORT_SESSION;
  if (!token || !supportSession) return undefined;
  return {
    baseUrl: env.PARITY_NEW_URL ?? 'http://127.0.0.1:8080',
    token,
    supportSession,
    tenant: env.PARITY_NEW_TENANT ?? '991825827',
  };
};

export const debugAccessFromEnv = (
  env: Record<string, string | undefined>,
): DebugAccess | undefined => {
  const debugKey = env.PARITY_OLD_DEBUG_KEY;
  if (!debugKey) return undefined;
  return { baseUrl: env.PARITY_OLD_URL ?? 'http://127.0.0.1:8099', debugKey };
};
