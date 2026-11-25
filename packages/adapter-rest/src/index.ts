import type { Principal } from '@genai/contracts';
import type { PortContext } from '@genai/kernel';
import { KnowledgeError, kindsOf, type KnowledgeRouter } from '@genai/port-knowledge';
import { Hono, type Context } from 'hono';
import { disjunctiveFacets } from './facets.js';
import { facetRequest } from './filters.js';
import {
  fileNameOf,
  listedPdf,
  openRemotePdf,
  remoteFileMaxBytes,
  type RemoteFileOptions,
} from './remote-file.js';

export { disjunctiveFacets, type FacetField, type FacetOption } from './facets.js';
export { facetRequest, filterMapErrors, toPortFilters, type FieldSpec } from './filters.js';
export { remoteFileOriginsFrom, type RemoteFileOptions } from './remote-file.js';

export interface Authenticator {
  authenticate(request: Request): Promise<Principal | undefined>;
}

export interface DatasetDescription {
  name: string;
  description: string;
}

export interface OriginalDocumentFile {
  name: string;
  type: string;
  body: Uint8Array;
}

export interface RestAdapterOptions {
  knowledge: KnowledgeRouter;
  auth: Authenticator;
  resolveDataset?: (tenant: string, datasetConfigKey: string) => string | undefined;
  describe?: (datasetId: string) => DatasetDescription | undefined;
  mayRead?: (principal: Principal, datasetId: string) => boolean | Promise<boolean>;
  status?: (datasetId: string) => string | Promise<string>;
  /** A document's uploaded original, for a caller its owner lets read it. */
  originalFile?: (
    principal: Principal,
    datasetId: string,
    documentId: string,
  ) => Promise<OriginalDocumentFile | undefined>;
  remoteFile?: RemoteFileOptions;
  newTaskId?: () => string;
}

type Env = { Variables: { principal: Principal } };

const failure = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 500 | 502,
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  c.json(
    {
      error: message,
      type: 'about:blank',
      title: message,
      status,
      detail: message,
      code,
      ...extra,
    },
    status,
    { 'content-type': 'application/problem+json', ...headers },
  );

const unauthenticated = (c: Context) =>
  failure(
    c,
    401,
    'Invalid or missing API key',
    'unauthorized',
    {},
    { 'WWW-Authenticate': 'Bearer' },
  );

const queryLimits: Record<string, { min: number; max?: number; optional?: boolean }> = {
  tenant: { min: 1 },
  'dataset-config-key': { min: 1 },
  fields: { min: 1, max: 512 },
  filter: { min: 1, max: 16384, optional: true },
};

const queryErrors = (c: Context) => {
  const humanized: Record<string, string[]> = {};
  for (const [name, rule] of Object.entries(queryLimits)) {
    const value = c.req.query(name);
    if (value === undefined) {
      if (!rule.optional) humanized[name] = ['missing required key'];
    } else if (value.length < rule.min) {
      humanized[name] = [`should be at least ${rule.min} character`];
    } else if (rule.max !== undefined && value.length > rule.max) {
      humanized[name] = [`should be at most ${rule.max} characters`];
    }
  }
  return Object.keys(humanized).length > 0 ? humanized : undefined;
};

/** The source's own address for a document, without a page or credentials; http or https only. */
export const sourceAddress = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
};

const mediaTypeFields = ['mediaType', 'mimeType', 'contentType', 'content_type', 'mime_type'];
const mediaTypePattern = /^[a-z]+\/[a-z0-9.+-]+$/;

export const sourceMediaType = (url: string, fields: Record<string, unknown>): string | null => {
  if (new URL(url).pathname.toLowerCase().endsWith('.pdf')) return 'application/pdf';
  for (const field of mediaTypeFields) {
    const value = fields[field];
    if (typeof value === 'string' && mediaTypePattern.test(value.trim().toLowerCase()))
      return value.trim().toLowerCase();
  }
  return null;
};

const attachment = (disposition: 'inline' | 'attachment', name: string) => {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

const isPdf = (type: string) =>
  (type.split(';')[0] ?? '').trim().toLowerCase() === 'application/pdf';

const wantsJson = (c: Context) => (c.req.header('accept') ?? '').includes('application/json');

export const createRestAdapter = (options: RestAdapterOptions) => {
  const app = new Hono<Env>();
  const describe = options.describe ?? (() => undefined);
  const mayRead = options.mayRead ?? (() => true);
  const newTaskId = options.newTaskId ?? (() => crypto.randomUUID());
  const resolveDataset =
    options.resolveDataset ??
    ((tenant: string, key: string) =>
      options.knowledge.resolve(`${tenant}/${key}`) ?? options.knowledge.resolve(key));

  const visible = async (principal: Principal) => {
    const out: string[] = [];
    for (const [id, dataset] of options.knowledge.datasets()) {
      const shared =
        !dataset.tenants ||
        (principal.tenant !== undefined && dataset.tenants.includes(principal.tenant));
      if (shared && (await mayRead(principal, id))) out.push(id);
    }
    return out.sort();
  };

  const summary = async (id: string) => {
    const about = describe(id);
    const known = options.knowledge.datasets().get(id);
    const short = id.slice(id.lastIndexOf('/') + 1);
    return {
      id: short,
      ...(id.includes('/') ? { tenant: id.slice(0, id.lastIndexOf('/')) } : {}),
      name: about?.name ?? known?.name ?? short,
      description: about?.description ?? known?.description ?? null,
      'enabled?': true,
      status: (await options.status?.(id)) ?? 'configured',
    };
  };

  app.use('/api/datasets', authenticate);
  app.use('/api/datasets/*', authenticate);
  app.use('/api/facets', authenticate);

  async function authenticate(c: Context<Env>, next: () => Promise<void>) {
    const principal = await options.auth.authenticate(c.req.raw);
    if (!principal) return unauthenticated(c);
    c.set('principal', principal);
    await next();
  }

  app.get('/api/datasets', async (c) => {
    try {
      const ids = await visible(c.get('principal'));
      return c.json({ datasets: await Promise.all(ids.map(summary)) }, 200);
    } catch {
      return failure(c, 500, 'Failed to list datasets', 'internal_error');
    }
  });

  const visibleDataset = async (principal: Principal, asked: string) => {
    const ids = await visible(principal);
    const id =
      options.knowledge.resolve(asked) ??
      ids.find((candidate) => candidate.slice(candidate.lastIndexOf('/') + 1) === asked);
    return id && ids.includes(id) ? id : undefined;
  };

  app.get('/api/datasets/:id{[^/]+(?:/[^/]+)?}/documents/:doc/file', async (c) => {
    const principal = c.get('principal');
    const id = await visibleDataset(principal, c.req.param('id') ?? '');
    if (!id) return failure(c, 404, 'Dataset not found', 'dataset_not_found');
    const doc = c.req.param('doc') ?? '';
    const noFile = () =>
      failure(c, 404, 'The document has no file to open', 'document_file_not_found');
    try {
      const port = options.knowledge.open(
        { kind: 'dataset', id },
        {
          tenant: principal.tenant ?? '',
          principal,
          task: newTaskId(),
          signal: c.req.raw.signal,
          meter: async () => undefined,
        },
      );
      if (!port.documents) return noFile();
      const found = (await port.documents({ ids: [doc], limit: 1 })).documents.find(
        (d) => d.id === doc,
      );
      if (!found) return failure(c, 404, 'Document not found', 'document_not_found');
      const original = await options.originalFile?.(principal, id, doc);
      const privately = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' };
      if (original) {
        const pdf = isPdf(original.type);
        if (wantsJson(c))
          return c.json(
            {
              kind: 'original',
              mediaType: pdf ? 'application/pdf' : original.type,
              name: original.name,
            },
            200,
            privately,
          );
        return c.body(original.body.slice().buffer, 200, {
          ...privately,
          'content-type': pdf ? 'application/pdf' : original.type,
          'content-length': String(original.body.byteLength),
          'content-disposition': attachment(pdf ? 'inline' : 'attachment', original.name),
          'x-content-type-options': 'nosniff',
          'content-security-policy': pdf
            ? "default-src 'none'; frame-ancestors 'self'"
            : "sandbox; default-src 'none'",
        });
      }
      const remote = options.remoteFile?.origins.length ? options.remoteFile : undefined;
      const asked = c.req.query('file');
      const listed = remote ? listedPdf(found, asked, remote.origins) : undefined;
      if (remote && asked !== undefined && !listed) return noFile();
      // A file its record says is over the cap is none to show, as kunnskapsassistenten's own server says.
      if (remote && listed && (listed.size ?? 0) > (remote.maxBytes ?? remoteFileMaxBytes))
        return noFile();
      const pdf = listed?.url;
      if (remote && pdf) {
        if (wantsJson(c))
          return c.json(
            { kind: 'served', mediaType: 'application/pdf', source: pdf },
            200,
            privately,
          );
        const headers = {
          ...privately,
          'content-type': 'application/pdf',
          'content-disposition': attachment('inline', fileNameOf(pdf)),
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; frame-ancestors 'self'",
        };
        let body: ReadableStream<Uint8Array> | undefined;
        try {
          body = await openRemotePdf(pdf, remote, c.req.raw.signal);
          return c.body(body, 200, headers);
        } catch (error) {
          await body?.cancel().catch(() => undefined);
          throw error;
        }
      }
      const source = sourceAddress(found.url);
      if (!source) return noFile();
      if (wantsJson(c))
        return c.json(
          { kind: 'source', url: source, mediaType: sourceMediaType(source, found.fields) },
          200,
          privately,
        );
      return c.redirect(source, 302);
    } catch (error) {
      if (
        error instanceof KnowledgeError &&
        (error.code === 'forbidden' || error.code === 'residency')
      )
        return failure(c, 404, 'Dataset not found', 'dataset_not_found');
      return failure(c, 502, 'The document cannot be read now', 'document_unavailable');
    }
  });

  app.get('/api/datasets/:id{.+}', async (c) => {
    try {
      const principal = c.get('principal');
      const id = await visibleDataset(principal, c.req.param('id') ?? '');
      if (!id) return failure(c, 404, 'Dataset not found', 'dataset_not_found');
      const filters = (() => {
        try {
          const port = options.knowledge.open(
            { kind: 'dataset', id },
            {
              tenant: principal.tenant ?? '',
              principal,
              task: newTaskId(),
              signal: c.req.raw.signal,
              meter: async () => undefined,
            },
          );
          const valueTypes = options.knowledge.datasets().get(id)?.valueTypes ?? {};
          return Object.entries(port.info().filters).map(([field, kind]) => ({
            field,
            kinds: kindsOf(kind),
            'value-type': valueTypes[field] ?? 'string',
          }));
        } catch {
          return [];
        }
      })();
      return c.json({ dataset: { ...(await summary(id)), filters } }, 200);
    } catch {
      return failure(c, 500, 'Failed to get dataset', 'internal_error');
    }
  });

  app.get('/api/facets', async (c) => {
    const humanized = queryErrors(c);
    if (humanized)
      return failure(c, 400, 'Request validation failed', 'invalid_request', {
        details: { in: ['request', 'query-params'], humanized },
      });
    const request = facetRequest(c.req.query('fields'), c.req.query('filter'));
    if (!request.ok) return failure(c, 400, request.error, 'invalid_request');

    const principal = c.get('principal');
    const id = resolveDataset(c.req.query('tenant') ?? '', c.req.query('dataset-config-key') ?? '');
    if (!id || !(await visible(principal)).includes(id))
      return failure(
        c,
        403,
        'API key is not allowed to access the selected dataset',
        'dataset_not_authorized',
      );

    const ctx: PortContext = {
      tenant: principal.tenant ?? '',
      principal,
      task: newTaskId(),
      signal: c.req.raw.signal,
      meter: async () => undefined,
    };
    try {
      const port = options.knowledge.open({ kind: 'dataset', id }, ctx);
      const fields = await disjunctiveFacets(port, request.fields, request.specs);
      return c.json({ fields }, 200);
    } catch (error) {
      if (error instanceof KnowledgeError) {
        if (error.code === 'bad_request') return failure(c, 400, error.message, 'invalid_request');
        if (error.code === 'forbidden' || error.code === 'residency')
          return failure(
            c,
            403,
            'API key is not allowed to access the selected dataset',
            'dataset_not_authorized',
          );
        return failure(c, 502, 'Facets are unavailable for this dataset.', 'facets_unavailable');
      }
      return failure(c, 500, 'Failed to fetch facets', 'internal_error');
    }
  });

  return app;
};
