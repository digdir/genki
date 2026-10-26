import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { secretRefPattern } from '@genai/kernel';
import type { EmbeddingAdapter } from './adapter.js';
import { residencies } from './port.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const secret = z.string().regex(secretRefPattern, 'must be a secret:// reference');

const auth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api-key'), secret, header: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('bearer'), secret }),
  z.strictObject({ kind: z.literal('token-provider'), provider: id }),
]);

const endpoint = z.strictObject({
  protocol: id,
  baseURL: z.url({ protocol: /^https?$/ }),
  auth,
  options: z.record(z.string(), z.unknown()).default({}),
});

const model = z.strictObject({
  id,
  endpoint: id,
  deployment: z.string().min(1),
  residency: z.enum(residencies),
  dimensions: z.number().int().positive(),
  maxBatch: z.number().int().positive().optional(),
  // Text the model wants before each input, such as multilingual-e5's 'query: ' and 'passage: '
  prompts: z
    .strictObject({ query: z.string().optional(), document: z.string().optional() })
    .optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const embeddingCatalog = z.strictObject({
  endpoints: z.record(id, endpoint),
  models: z.array(model).default([]),
});

export type EmbeddingCatalog = z.infer<typeof embeddingCatalog>;
export type CatalogEmbedder = EmbeddingCatalog['models'][number];
export type CatalogEmbeddingEndpoint = EmbeddingCatalog['endpoints'][string];

export type EmbeddingCatalogResult =
  | { ok: true; catalog: EmbeddingCatalog }
  | { ok: false; errors: { path: string; message: string }[] };

const pathOf = (base: (string | number)[], issue: { path: PropertyKey[] }) =>
  [...base, ...issue.path].map(String).join('.');

export const parseEmbeddingCatalog = (
  input: unknown,
  adapters: EmbeddingAdapter[],
): EmbeddingCatalogResult => {
  const parsed = embeddingCatalog.safeParse(input);
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
    const options = adapter.endpointOptions.safeParse(e.options);
    if (!options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['endpoints', name, 'options'], i), message: i.message });
    }
  }

  catalog.models.forEach((m, index) => {
    if (catalog.models.findIndex((other) => other.id === m.id) !== index)
      errors.push({ path: `models.${index}.id`, message: `duplicate embedder ${m.id}` });
    const e = catalog.endpoints[m.endpoint];
    if (!e) {
      errors.push({ path: `models.${index}.endpoint`, message: `unknown endpoint ${m.endpoint}` });
      return;
    }
    const options = byProtocol.get(e.protocol)?.modelOptions.safeParse(m.options);
    if (options && !options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['models', index, 'options'], i), message: i.message });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, catalog };
};

export const parseEmbeddingCatalogYaml = (
  text: string,
  adapters: EmbeddingAdapter[],
): EmbeddingCatalogResult => {
  try {
    return parseEmbeddingCatalog(parseYaml(text), adapters);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: '', message: `not valid YAML: ${(error as Error).message}` }],
    };
  }
};
