import type { JSONSchema } from '@genai/contracts';
import { parse as parseYaml } from 'yaml';

export const httpMethods = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof httpMethods)[number];

export interface OperationParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description?: string;
  schema: JSONSchema;
}

export interface Operation {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  parameters: OperationParameter[];
  body?: { schema: JSONSchema; required: boolean };
  readOnly: boolean;
}

export class OpenApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const parseDocument = (text: string): Record<string, unknown> => {
  let doc: unknown;
  try {
    doc = text.trimStart().startsWith('{')
      ? JSON.parse(text)
      : parseYaml(text, { maxAliasCount: 50 });
  } catch (error) {
    throw new OpenApiError(`the document is neither JSON nor YAML: ${(error as Error).message}`);
  }
  if (!isRecord(doc)) throw new OpenApiError('the document is not an object');
  if (typeof doc.openapi !== 'string' || !/^3\.[01]\./.test(doc.openapi))
    throw new OpenApiError('only OpenAPI 3.0 and 3.1 documents are supported');
  if (!isRecord(doc.paths)) throw new OpenApiError('the document has no paths');
  return doc;
};

const pointer = (doc: Record<string, unknown>, ref: string): unknown => {
  if (!ref.startsWith('#/')) throw new OpenApiError(`only local references are supported: ${ref}`);
  let at: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isRecord(at) || !(key in at)) throw new OpenApiError(`unresolved reference ${ref}`);
    at = at[key];
  }
  return at;
};

const maxDepth = 12;

export const deref = (
  doc: Record<string, unknown>,
  value: unknown,
  seen: string[] = [],
): unknown => {
  if (Array.isArray(value)) return value.map((v) => deref(doc, v, seen));
  if (!isRecord(value)) return value;
  if (typeof value.$ref === 'string') {
    if (seen.includes(value.$ref) || seen.length >= maxDepth) return {};
    return deref(doc, pointer(doc, value.$ref), [...seen, value.$ref]);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !k.startsWith('x-'))
      .map(([k, v]) => [k, deref(doc, v, seen)]),
  );
};

export const operationSlug = (method: string, path: string) =>
  `${method}_${path}`
    .replace(/[{}]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

const blockedHeaders = new Set([
  'authorization',
  'cookie',
  'host',
  'content-type',
  'content-length',
]);

const parametersOf = (doc: Record<string, unknown>, raw: unknown): OperationParameter[] =>
  (Array.isArray(raw) ? raw : []).flatMap((p): OperationParameter[] => {
    const param = deref(doc, p);
    if (!isRecord(param) || typeof param.name !== 'string') return [];
    if (param.in !== 'path' && param.in !== 'query' && param.in !== 'header') return [];
    if (param.in === 'header' && blockedHeaders.has(param.name.toLowerCase())) return [];
    return [
      {
        name: param.name,
        in: param.in,
        required: param.in === 'path' || param.required === true,
        ...(typeof param.description === 'string' ? { description: param.description } : {}),
        schema: isRecord(param.schema) ? param.schema : { type: 'string' },
      },
    ];
  });

const bodyOf = (doc: Record<string, unknown>, raw: unknown): Operation['body'] => {
  const body = deref(doc, raw);
  if (!isRecord(body) || !isRecord(body.content)) return undefined;
  const json = Object.entries(body.content).find(([type]) =>
    /^application\/(.+\+)?json/.test(type),
  );
  if (!json) return undefined;
  const media = json[1];
  return {
    schema: isRecord(media) && isRecord(media.schema) ? media.schema : { type: 'object' },
    required: body.required === true,
  };
};

export const operationsOf = (doc: Record<string, unknown>): Operation[] => {
  const out: Operation[] = [];
  const ids = new Set<string>();
  for (const [path, rawItem] of Object.entries(doc.paths as Record<string, unknown>)) {
    const item = deref(doc, rawItem);
    if (!isRecord(item)) continue;
    for (const method of httpMethods) {
      const op = item[method];
      if (!isRecord(op)) continue;
      const shared = parametersOf(doc, item.parameters);
      const own = parametersOf(doc, op.parameters);
      const parameters = [
        ...shared.filter((s) => !own.some((o) => o.name === s.name && o.in === s.in)),
        ...own,
      ];
      let id =
        typeof op.operationId === 'string' && op.operationId.trim() !== ''
          ? op.operationId.trim()
          : operationSlug(method, path);
      if (ids.has(id)) id = `${id}_${operationSlug(method, path)}`;
      ids.add(id);
      const body = bodyOf(doc, op.requestBody);
      out.push({
        id,
        method,
        path,
        summary: [op.summary, op.description]
          .filter((s): s is string => typeof s === 'string' && s.trim() !== '')
          .join(' ')
          .slice(0, 1000),
        parameters,
        ...(body ? { body } : {}),
        readOnly: method === 'get',
      });
    }
  }
  return out;
};

export const inputSchemaOf = (op: Operation): JSONSchema => {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];
  for (const p of op.parameters) {
    properties[p.name] = { ...p.schema, ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(p.name);
  }
  if (op.body) {
    properties.body = { ...op.body.schema, description: 'The JSON request body.' };
    if (op.body.required) required.push('body');
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
};
