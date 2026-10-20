import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { secretRefPattern } from '@genai/kernel';
import type { ModelAdapter } from './adapter.js';
import { parameterRules } from './parameters.js';
import { capabilities, residencies } from './port.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const secret = z.string().regex(secretRefPattern, 'must be a secret:// reference');

const auth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api-key'), secret, header: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('bearer'), secret }),
  z.strictObject({ kind: z.literal('token-provider'), provider: id }),
]);

const discovery = z.strictObject({
  source: id,
  from: id.optional(),
  include: z.array(z.string().min(1)).default(['*']),
  exclude: z.array(z.string().min(1)).default([]),
  capabilities: z.array(z.enum(capabilities)).default(['stream']),
});

const endpoint = z.strictObject({
  protocol: id,
  baseURL: z.url({ protocol: /^https?$/ }),
  auth,
  options: z.record(z.string(), z.unknown()).default({}),
  discovery: discovery.optional(),
});

const model = z.strictObject({
  id,
  endpoint: id,
  deployment: z.string().min(1),
  family: z.string().min(1).optional(),
  residency: z.enum(residencies),
  capabilities: z.array(z.enum(capabilities)).default([]),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  parameters: parameterRules.optional(),
  tenants: z.array(z.string().regex(/^\d{9}$/)).optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const modelCatalog = z.strictObject({
  endpoints: z.record(id, endpoint),
  models: z.array(model).default([]),
});

export type ModelCatalog = z.infer<typeof modelCatalog>;
export type CatalogModel = ModelCatalog['models'][number];
export type CatalogEndpoint = ModelCatalog['endpoints'][string];

export type CatalogResult =
  { ok: true; catalog: ModelCatalog } | { ok: false; errors: { path: string; message: string }[] };

const pathOf = (base: (string | number)[], issue: { path: PropertyKey[] }) =>
  [...base, ...issue.path].map(String).join('.');

export const parseCatalog = (
  input: unknown,
  adapters: ModelAdapter[],
  sources?: string[],
): CatalogResult => {
  const parsed = modelCatalog.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: pathOf([], i), message: i.message })),
    };
  }
  const catalog = parsed.data;
  const errors: { path: string; message: string }[] = [];
  const byProtocol = new Map(adapters.map((a) => [a.protocol, a]));

  for (const [name, e] of Object.entries(catalog.endpoints)) {
    const adapter = byProtocol.get(e.protocol);
    if (!adapter) {
      errors.push({ path: `endpoints.${name}.protocol`, message: `no adapter for ${e.protocol}` });
      continue;
    }
    if (e.discovery) {
      if (sources && !sources.includes(e.discovery.source))
        errors.push({
          path: `endpoints.${name}.discovery.source`,
          message: `no discovery source ${e.discovery.source}`,
        });
      if (e.discovery.from && !catalog.endpoints[e.discovery.from])
        errors.push({
          path: `endpoints.${name}.discovery.from`,
          message: `unknown endpoint ${e.discovery.from}`,
        });
    }
    const options = adapter.endpointOptions.safeParse(e.options);
    if (!options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['endpoints', name, 'options'], i), message: i.message });
    }
  }

  catalog.models.forEach((m, index) => {
    if (catalog.models.findIndex((other) => other.id === m.id) !== index)
      errors.push({ path: `models.${index}.id`, message: `duplicate model ${m.id}` });
    const e = catalog.endpoints[m.endpoint];
    if (!e) {
      errors.push({ path: `models.${index}.endpoint`, message: `unknown endpoint ${m.endpoint}` });
      return;
    }
    const adapter = byProtocol.get(e.protocol);
    const options = adapter?.modelOptions.safeParse(m.options);
    if (options && !options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['models', index, 'options'], i), message: i.message });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, catalog };
};

export const parseCatalogYaml = (text: string, adapters: ModelAdapter[]): CatalogResult => {
  try {
    return parseCatalog(parseYaml(text), adapters);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: '', message: `not valid YAML: ${(error as Error).message}` }],
    };
  }
};
