import { z } from 'zod';
import { secretRefPattern, withoutTrailingSlashes } from '@genai/kernel';
import { currentApiId, type DescriptorRegistry } from '@genai/operations';
import type { EmbeddingAdapter } from './adapter.js';
import { residencies } from './port.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const secret = z.string().regex(secretRefPattern, 'must be a secret:// reference');

const auth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api-key'), secret, header: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('bearer'), secret }),
  z.strictObject({ kind: z.literal('token-provider'), provider: id }),
]);

const connection = z.object({
  baseURL: z.url({ protocol: /^https?$/ }),
  auth,
  families: z.record(z.string(), z.string()),
});

/** An embedding model in the model catalogue, as the embedding port reads it. */
export const embeddingModel = z.object({
  id,
  endpoint: id,
  deployment: z.string().min(1),
  residency: z.enum(residencies),
  tenants: z.array(z.string().regex(/^\d{9}$/)).optional(),
  apis: z.object({ embed: z.string() }),
  embed: z.strictObject({
    dimensions: z.number().int().positive(),
    maxBatch: z.number().int().positive().optional(),
  }),
  options: z.record(z.string(), z.unknown()).default({}),
});

export type EmbeddingConnectionSpec = z.infer<typeof connection>;

export interface CatalogEmbedder {
  id: string;
  endpoint: string;
  deployment: string;
  residency: (typeof residencies)[number];
  dimensions: number;
  maxBatch?: number;
  tenants?: string[];
  api: string;
  family: string;
  baseURL: string;
  options: Record<string, unknown>;
}

export interface EmbedderCatalog {
  connections: Record<string, EmbeddingConnectionSpec>;
  embedders: CatalogEmbedder[];
}

export type EmbedderCatalogResult =
  | { ok: true; catalog: EmbedderCatalog }
  | { ok: false; errors: { path: string; message: string }[] };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const familyURL = (baseURL: string, base: string) =>
  /^https?:\/\//.test(base)
    ? withoutTrailingSlashes(base)
    : withoutTrailingSlashes(`${withoutTrailingSlashes(baseURL)}${base}`);

const pathOf = (base: (string | number)[], issue: { path: PropertyKey[] }) =>
  [...base, ...issue.path].map(String).join('.');

/** The embedders of a model catalogue: its models that bind an API for `embed` (ADR 0048). */
export const parseEmbedders = (
  modelCatalog: unknown,
  adapters: readonly EmbeddingAdapter[],
  descriptors?: DescriptorRegistry,
): EmbedderCatalogResult => {
  const catalog = record(modelCatalog);
  const endpoints = record(catalog.endpoints);
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const errors: { path: string; message: string }[] = [];
  const connections: Record<string, EmbeddingConnectionSpec> = {};
  const embedders: CatalogEmbedder[] = [];
  models.forEach((raw, index) => {
    if (typeof record(record(raw).apis).embed !== 'string') return;
    const at = ['models', index];
    const parsed = embeddingModel.safeParse(raw);
    if (!parsed.success) {
      for (const i of parsed.error.issues) errors.push({ path: pathOf(at, i), message: i.message });
      return;
    }
    const m = parsed.data;
    const api = currentApiId(m.apis.embed);
    const adapter = adapters.find((a) => a.api.id === api);
    const descriptor = adapter ? undefined : descriptors?.get(api);
    const family = adapter?.api.family ?? descriptor?.api.family;
    if (!adapter && (descriptor?.status !== 'typed' || descriptor.operation !== 'embed')) {
      errors.push({
        path: `models.${index}.apis.embed`,
        message: `no built-in implementation or typed embed descriptor ${api}`,
      });
      return;
    }
    const spec = connection.safeParse(endpoints[m.endpoint]);
    if (!spec.success) {
      errors.push({ path: `models.${index}.endpoint`, message: `unknown endpoint ${m.endpoint}` });
      return;
    }
    const base = spec.data.families[family as string];
    if (base === undefined) {
      errors.push({
        path: `models.${index}.apis.embed`,
        message: `the connection does not offer the ${family} family ${api} needs`,
      });
      return;
    }
    const options = adapter?.modelOptions.safeParse(m.options);
    if (options && !options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf([...at, 'options'], i), message: i.message });
      return;
    }
    connections[m.endpoint] = spec.data;
    embedders.push({
      id: m.id,
      endpoint: m.endpoint,
      deployment: m.deployment,
      residency: m.residency,
      dimensions: m.embed.dimensions,
      ...(m.embed.maxBatch === undefined ? {} : { maxBatch: m.embed.maxBatch }),
      ...(m.tenants ? { tenants: m.tenants } : {}),
      api,
      family: family as string,
      baseURL: familyURL(spec.data.baseURL, base),
      options: m.options,
    });
  });
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, catalog: { connections, embedders } };
};
