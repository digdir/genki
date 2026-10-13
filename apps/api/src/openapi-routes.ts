import type { OpenAPIHono } from '@hono/zod-openapi';
import { reasonFreeWrites, writeMethods } from './change-reason.js';
import { minimumReasonLength } from './http.js';
import { apiTags, tagOf } from './openapi/tags.js';

type Document = ReturnType<OpenAPIHono['getOpenAPI31Document']>;
type Operation = Record<string, unknown>;

const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

export const openApiPath = (path: string) =>
  path.includes('*')
    ? undefined
    : path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g, (_, name: string) => `{${name}}`);

const parametersOf = (path: string) =>
  [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

export const documentedRoutes = (routes: { method: string; path: string }[]) =>
  routes.flatMap((route) => {
    const method = route.method.toLowerCase();
    const path = openApiPath(route.path);
    return methods.has(method) && path ? [{ method, path }] : [];
  });

export const withUndocumentedRoutes = (
  doc: Document,
  routes: { method: string; path: string }[],
): Document => {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Operation>>;
  for (const { method, path } of documentedRoutes(routes)) {
    const item = (paths[path] ??= {});
    if (item[method]) continue;
    const parameters = parametersOf(path);
    item[method] = {
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: { default: { description: 'See the route' } },
    };
  }
  return { ...doc, paths } as Document;
};

export const withTags = (doc: Document): Document => {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Operation>>;
  for (const [path, item] of Object.entries(paths)) {
    const tag = tagOf(path);
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      if (tag) operation.tags = [tag];
      else delete operation.tags;
    }
  }
  return { ...doc, paths, tags: apiTags.map((tag) => ({ ...tag })) } as Document;
};

const changeReasonHeader = {
  name: 'change-reason',
  in: 'header',
  required: true,
  description: `Why the change is made, at least ${minimumReasonLength} characters, URI-encoded. It is stored in the audit log.`,
  schema: { type: 'string', minLength: minimumReasonLength },
};

const reasonMissing = {
  description: 'The request could not be read, or the change-reason header is missing or too short',
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
};

export const withChangeReasons = (
  doc: Document,
  routes: { method: string; path: string }[],
): Document => {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, Operation>>;
  for (const route of routes) {
    if (!writeMethods.has(route.method) || `${route.method} ${route.path}` in reasonFreeWrites)
      continue;
    const path = openApiPath(route.path);
    const operation = path && paths[path]?.[route.method.toLowerCase()];
    if (!operation) continue;
    const parameters = (operation.parameters ?? []) as { name?: string; in?: string }[];
    operation.parameters = [
      ...parameters.filter((p) => !(p.in === 'header' && p.name === 'change-reason')),
      changeReasonHeader,
    ];
    const responses = (operation.responses ?? {}) as Record<string, unknown>;
    operation.responses = { ...responses, 400: responses[400] ?? reasonMissing };
  }
  return { ...doc, paths } as Document;
};
