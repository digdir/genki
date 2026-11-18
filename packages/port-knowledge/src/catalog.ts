import { sourceLinkRules } from '@genai/contracts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { secretRef, type KnowledgeAdapter } from './adapter.js';
import { filterKinds, filterValueTypes, residencies } from './port.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const secret = secretRef();

export const knowledgeEndpointAuth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api-key'), secret, header: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('bearer'), secret }),
  z.strictObject({ kind: z.literal('token-provider'), provider: id }),
]);

const baseURL = z.url({ protocol: /^https?$/ });

const endpoint = z.strictObject({
  engine: id,
  name: z.string().trim().min(1).max(120).optional(),
  baseURL: baseURL.optional(),
  auth: knowledgeEndpointAuth.optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const knowledgeEndpointSchemaFor = (adapter: KnowledgeAdapter) =>
  adapter.requiresBaseURL === false
    ? z.strictObject({
        engine: z.literal(adapter.engine),
        name: z.string().trim().min(1).max(120).optional(),
        options: adapter.endpointOptions.optional(),
      })
    : z.strictObject({
        engine: z.literal(adapter.engine),
        name: z.string().trim().min(1).max(120).optional(),
        baseURL,
        auth: knowledgeEndpointAuth,
        options: adapter.endpointOptions.optional(),
      });

const dataset = z.strictObject({
  id,
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  aliases: z.array(id).default([]),
  endpoint: id,
  residency: z.enum(residencies),
  filters: z
    .record(z.string(), z.union([z.enum(filterKinds), z.array(z.enum(filterKinds)).min(1)]))
    .default({}),
  valueTypes: z.record(z.string(), z.enum(filterValueTypes)).optional(),
  tenants: z.array(z.string().regex(/^\d{9}$/)).optional(),
  links: z.enum(sourceLinkRules).optional(),
  embedding: z
    .strictObject({ model: id, dimensions: z.number().int().positive().max(16_384) })
    .optional(),
  generation: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const knowledgeCatalog = z.strictObject({
  endpoints: z.record(id, endpoint),
  datasets: z.array(dataset),
});

export type KnowledgeCatalog = z.infer<typeof knowledgeCatalog>;
export type CatalogDataset = KnowledgeCatalog['datasets'][number];
export type CatalogKnowledgeEndpoint = KnowledgeCatalog['endpoints'][string];

export type KnowledgeCatalogResult =
  | { ok: true; catalog: KnowledgeCatalog }
  | { ok: false; errors: { path: string; message: string }[] };

const pathOf = (base: (string | number)[], issue: { path: PropertyKey[] }) =>
  [...base, ...issue.path].map(String).join('.');

export const parseKnowledgeCatalog = (
  input: unknown,
  adapters: KnowledgeAdapter[],
): KnowledgeCatalogResult => {
  const parsed = knowledgeCatalog.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: pathOf([], i), message: i.message })),
    };
  }
  const catalog = parsed.data;
  const errors: { path: string; message: string }[] = [];
  const byEngine = new Map(adapters.map((a) => [a.engine, a]));

  for (const [name, e] of Object.entries(catalog.endpoints)) {
    const adapter = byEngine.get(e.engine);
    if (!adapter) {
      errors.push({ path: `endpoints.${name}.engine`, message: `no adapter for ${e.engine}` });
      continue;
    }
    if (adapter.requiresBaseURL !== false) {
      if (!e.baseURL)
        errors.push({ path: `endpoints.${name}.baseURL`, message: `${e.engine} needs a baseURL` });
      if (!e.auth)
        errors.push({ path: `endpoints.${name}.auth`, message: `${e.engine} needs auth` });
    }
    const options = adapter.endpointOptions.safeParse(e.options);
    if (!options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['endpoints', name, 'options'], i), message: i.message });
    }
  }

  catalog.datasets.forEach((d, index) => {
    if (catalog.datasets.findIndex((other) => other.id === d.id) !== index)
      errors.push({ path: `datasets.${index}.id`, message: `duplicate dataset ${d.id}` });
    d.aliases.forEach((alias, a) => {
      const taken = catalog.datasets.some(
        (other, o) => other.id === alias || (o !== index && other.aliases.includes(alias)),
      );
      if (taken)
        errors.push({ path: `datasets.${index}.aliases.${a}`, message: `alias ${alias} is taken` });
    });
    const e = catalog.endpoints[d.endpoint];
    if (!e) {
      errors.push({
        path: `datasets.${index}.endpoint`,
        message: `unknown endpoint ${d.endpoint}`,
      });
      return;
    }
    const options = byEngine.get(e.engine)?.datasetOptions.safeParse(d.options);
    if (options && !options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['datasets', index, 'options'], i), message: i.message });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, catalog };
};

export const parseKnowledgeCatalogYaml = (
  text: string,
  adapters: KnowledgeAdapter[],
): KnowledgeCatalogResult => {
  try {
    return parseKnowledgeCatalog(parseYaml(text), adapters);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: '', message: `not valid YAML: ${(error as Error).message}` }],
    };
  }
};
