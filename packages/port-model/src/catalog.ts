import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { secretRefPattern, withoutTrailingSlashes } from '@genai/kernel';
import { apiFamilyPattern } from '@genai/operations';
import type { ModelAdapter } from './adapter.js';
import { apiIdPattern, apiRegistry, type ApiRegistry } from './apis.js';
import { parameterRules } from './parameters.js';
import { capabilities, operationKindPattern, residencies } from './port.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const secret = z.string().regex(secretRefPattern, 'must be a secret:// reference');

const auth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api-key'), secret, header: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('bearer'), secret }),
  z.strictObject({ kind: z.literal('token-provider'), provider: id }),
]);

const bindings = z.record(z.string().regex(operationKindPattern), z.string().regex(apiIdPattern));

const familyBase = z.union([
  z.string().regex(/^(\/[A-Za-z0-9._~-]+)*\/?$/, 'a path under baseURL or a full URL'),
  z.url({ protocol: /^https?$/ }),
]);

const discoveryRule = z.strictObject({
  source: id,
  from: id.optional(),
  idPrefix: id.optional(),
  include: z.array(z.string().min(1)).default(['*']),
  exclude: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.enum(capabilities)).default(['stream']),
  apis: bindings.optional(),
});

export const allowedHostPattern =
  /^(?![\d.]+(?::\d+)?$)(?=.{1,253}(?::\d{1,5})?$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{1,5})?$/;

const endpoint = z.strictObject({
  baseURL: z.url({ protocol: /^https?$/ }),
  auth,
  families: z
    .record(z.string().regex(apiFamilyPattern), familyBase)
    .refine((f) => Object.keys(f).length > 0, 'a connection offers at least one API family'),
  discovery: z.array(discoveryRule).default([]),
  allowedHosts: z.array(z.string().regex(allowedHostPattern)).max(20).optional(),
});

export const rerankFailureModes = ['degrade', 'fail'] as const;

/** Settings that belong to one operation kind, kept under the kind's name on the model. */
export const kindSettings = {
  embed: z.strictObject({
    dimensions: z.number().int().positive(),
    maxBatch: z.number().int().positive().optional(),
  }),
  rerank: z.strictObject({ onFailure: z.enum(rerankFailureModes).default('degrade') }),
};

const model = z.strictObject({
  id,
  endpoint: id,
  deployment: z.string().min(1),
  family: z.string().min(1).optional(),
  residency: z.enum(residencies),
  capabilities: z.array(z.enum(capabilities)).default([]),
  apis: bindings.optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  parameters: parameterRules.optional(),
  tenants: z.array(z.string().regex(/^\d{9}$/)).optional(),
  embed: kindSettings.embed.optional(),
  rerank: kindSettings.rerank.optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const modelCatalog = z.strictObject({
  endpoints: z.record(id, endpoint),
  models: z.array(model).default([]),
});

export type ModelCatalog = z.infer<typeof modelCatalog>;
export type CatalogModel = ModelCatalog['models'][number];
export type CatalogEndpoint = ModelCatalog['endpoints'][string];
export type DiscoveryRule = CatalogEndpoint['discovery'][number];
export type ApiBindings = Record<string, string>;

export type CatalogResult =
  { ok: true; catalog: ModelCatalog } | { ok: false; errors: { path: string; message: string }[] };

const pathOf = (base: (string | number)[], issue: { path: PropertyKey[] }) =>
  [...base, ...issue.path].map(String).join('.');

/** The URL a connection serves one family at: its base under `baseURL`, or the base itself when it is a full URL. */
export const familyURL = (endpoint: Pick<CatalogEndpoint, 'baseURL'>, base: string) =>
  /^https?:\/\//.test(base)
    ? withoutTrailingSlashes(base)
    : withoutTrailingSlashes(`${withoutTrailingSlashes(endpoint.baseURL)}${base}`);

/** The bindings a model without `apis` gets: each kind's default API, when the connection offers one family. */
export const defaultBindings = (
  families: readonly string[],
  apis: ApiRegistry,
  kinds: readonly string[] = ['chat'],
): ApiBindings | undefined => {
  if (families.length !== 1) return undefined;
  const found = kinds.flatMap((kind) => {
    const api = apis.defaultFor(kind, families[0] as string);
    return api ? [[kind, api] as const] : [];
  });
  return found.length > 0 ? Object.fromEntries(found) : undefined;
};

export const bindingsOf = (
  model: Pick<CatalogModel, 'apis'>,
  endpoint: Pick<CatalogEndpoint, 'families'> | undefined,
  apis: ApiRegistry,
): ApiBindings =>
  model.apis ??
  (endpoint ? defaultBindings(Object.keys(endpoint.families), apis) : undefined) ??
  {};

/** Why a binding is invalid: the API must exist, be of the kind it is bound for, and be in a family the connection offers. */
export const bindingProblem = (
  kind: string,
  apiId: string,
  families: readonly string[],
  apis: ApiRegistry,
): string | undefined => {
  const api = apis.get(apiId);
  if (!api) return `no API ${apiId}`;
  if (api.kind !== kind) return `${apiId} is an API for ${api.kind}, not ${kind}`;
  if (!families.includes(api.family))
    return `the connection does not offer the ${api.family} family ${apiId} needs`;
  if (kind === 'chat' && !apis.builtIn(apiId)) return `${apiId} has no built-in implementation`;
  return undefined;
};

export const modelOptionsSchema = (bound: ApiBindings, apis: ApiRegistry) =>
  z.strictObject(
    Object.assign(
      {},
      ...Object.values(bound).map((apiId) => apis.builtIn(apiId)?.api.modelOptions.shape ?? {}),
    ) as z.ZodRawShape,
  );

const registryOf = (apis: ApiRegistry | readonly ModelAdapter[]): ApiRegistry =>
  Array.isArray(apis) ? apiRegistry(apis) : (apis as ApiRegistry);

export const parseCatalog = (
  input: unknown,
  registry: ApiRegistry | readonly ModelAdapter[],
  sources?: string[],
): CatalogResult => {
  const parsed = modelCatalog.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: pathOf([], i), message: i.message })),
    };
  }
  const apis = registryOf(registry);
  const catalog = parsed.data;
  const errors: { path: string; message: string }[] = [];
  const bindingErrors = (at: string, bound: ApiBindings, families: string[]) => {
    for (const [kind, apiId] of Object.entries(bound)) {
      const problem = bindingProblem(kind, apiId, families, apis);
      if (problem) errors.push({ path: `${at}.${kind}`, message: problem });
    }
  };

  for (const [name, e] of Object.entries(catalog.endpoints)) {
    const families = Object.keys(e.families);
    e.discovery.forEach((rule, index) => {
      const at = `endpoints.${name}.discovery.${index}`;
      if (sources && !sources.includes(rule.source))
        errors.push({ path: `${at}.source`, message: `no discovery source ${rule.source}` });
      if (rule.from && !catalog.endpoints[rule.from])
        errors.push({ path: `${at}.from`, message: `unknown endpoint ${rule.from}` });
      if (rule.apis) bindingErrors(`${at}.apis`, rule.apis, families);
      else if (!defaultBindings(families, apis))
        errors.push({
          path: `${at}.apis`,
          message: 'name the APIs; the connection offers no single default',
        });
    });
  }

  catalog.models.forEach((m, index) => {
    if (catalog.models.findIndex((other) => other.id === m.id) !== index)
      errors.push({ path: `models.${index}.id`, message: `duplicate model ${m.id}` });
    const e = catalog.endpoints[m.endpoint];
    if (!e) {
      errors.push({ path: `models.${index}.endpoint`, message: `unknown endpoint ${m.endpoint}` });
      return;
    }
    const bound = bindingsOf(m, e, apis);
    if (Object.keys(bound).length === 0) {
      errors.push({
        path: `models.${index}.apis`,
        message: 'name at least one API; the connection offers no single default',
      });
      return;
    }
    bindingErrors(`models.${index}.apis`, bound, Object.keys(e.families));
    if (bound.embed && !m.embed)
      errors.push({
        path: `models.${index}.embed`,
        message: 'an embedding model names its dimensions under embed',
      });
    const options = modelOptionsSchema(bound, apis).safeParse(m.options);
    if (!options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['models', index, 'options'], i), message: i.message });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, catalog };
};

export const parseCatalogYaml = (
  text: string,
  registry: ApiRegistry | readonly ModelAdapter[],
): CatalogResult => {
  try {
    return parseCatalog(parseYaml(text), registry);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: '', message: `not valid YAML: ${(error as Error).message}` }],
    };
  }
};
