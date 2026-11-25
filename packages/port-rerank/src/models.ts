import { z } from 'zod';
import {
  federatedScopePattern,
  guidPattern,
  secretRefPattern,
  withoutTrailingSlashes,
} from '@genai/kernel';
import { currentApiId, type DescriptorRegistry } from '@genai/operations';
import type { RerankAdapter } from './adapter.js';
import { failureModes, residencies, type FailureMode, type Residency } from './port.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const secret = z.string().regex(secretRefPattern, 'must be a secret:// reference');

const auth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api-key'), secret, header: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('bearer'), secret }),
  z.strictObject({ kind: z.literal('token-provider'), provider: id }),
  z.strictObject({
    kind: z.literal('federated-app'),
    clientId: z.string().regex(guidPattern, 'a GUID'),
    tenant: z.string().regex(guidPattern, 'a GUID'),
    scope: z.string().regex(federatedScopePattern, 'a scope ending in /.default'),
  }),
]);

const connection = z.object({
  baseURL: z.url({ protocol: /^https?$/ }),
  auth,
  families: z.record(z.string(), z.string()),
  settings: z.record(z.string(), z.string()).optional(),
  keys: z.record(z.string(), secret).optional(),
  gateway: z.boolean().optional(),
});

const reranker = z.object({
  id,
  endpoint: id,
  deployment: z.string().min(1).optional(),
  residency: z.enum(residencies),
  tenants: z.array(z.string().regex(/^\d{9}$/)).optional(),
  apis: z.object({ rerank: z.string() }),
  rerank: z.strictObject({ onFailure: z.enum(failureModes).default('degrade') }).optional(),
  options: z.record(z.string(), z.unknown()).default({}),
});

export interface ModelReranker {
  id: string;
  endpoint: string;
  residency: Residency;
  onFailure: FailureMode;
  tenants?: string[];
  deployment?: string;
  api: string;
  /** Set when a typed rerank descriptor serves the API instead of a built-in adapter. */
  described?: boolean;
  baseURL: string;
  auth: z.infer<typeof auth>;
  gateway: boolean;
  settings?: Record<string, string>;
  keys?: Record<string, string>;
  options: Record<string, unknown>;
}

export type ModelRerankersResult =
  | { ok: true; rerankers: ModelReranker[] }
  | { ok: false; errors: { path: string; message: string }[] };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const familyURL = (baseURL: string, base: string) =>
  /^https?:\/\//.test(base)
    ? withoutTrailingSlashes(base)
    : withoutTrailingSlashes(`${withoutTrailingSlashes(baseURL)}${base}`);

/** The rerankers of a model catalogue: its models that bind an API for `rerank` (ADR 0048). */
export const parseModelRerankers = (
  modelCatalog: unknown,
  adapters: readonly RerankAdapter[],
  descriptors?: DescriptorRegistry,
): ModelRerankersResult => {
  const catalog = record(modelCatalog);
  const endpoints = record(catalog.endpoints);
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const errors: { path: string; message: string }[] = [];
  const rerankers: ModelReranker[] = [];
  models.forEach((raw, index) => {
    if (typeof record(record(raw).apis).rerank !== 'string') return;
    const parsed = reranker.safeParse(raw);
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        errors.push({ path: ['models', index, ...i.path].join('.'), message: i.message });
      return;
    }
    const m = parsed.data;
    const apiId = currentApiId(m.apis.rerank);
    const adapter = adapters.find((a) => a.api?.id === apiId);
    const descriptor = adapter?.api ? undefined : descriptors?.get(apiId);
    const described = descriptor?.status === 'typed' && descriptor.operation === 'rerank';
    const family = adapter?.api?.family ?? (described ? descriptor.api.family : undefined);
    if (!family) {
      errors.push({
        path: `models.${index}.apis.rerank`,
        message: `no built-in implementation or typed rerank descriptor ${m.apis.rerank}`,
      });
      return;
    }
    const spec = connection.safeParse(endpoints[m.endpoint]);
    const base = spec.success ? spec.data.families[family] : undefined;
    if (!spec.success || base === undefined) {
      errors.push({
        path: `models.${index}.endpoint`,
        message: `${m.endpoint} does not offer the ${family} family`,
      });
      return;
    }
    if (described && !m.deployment) {
      errors.push({
        path: `models.${index}.deployment`,
        message: 'a reranker served by a descriptor names its deployment',
      });
      return;
    }
    const options = adapter ? adapter.rerankerOptions.safeParse(m.options) : undefined;
    if (options && !options.success) {
      for (const i of options.error.issues)
        errors.push({
          path: ['models', index, 'options', ...i.path].join('.'),
          message: i.message,
        });
      return;
    }
    rerankers.push({
      id: m.id,
      endpoint: m.endpoint,
      residency: m.residency,
      onFailure: m.rerank?.onFailure ?? 'degrade',
      ...(m.tenants ? { tenants: m.tenants } : {}),
      ...(m.deployment ? { deployment: m.deployment } : {}),
      api: apiId,
      ...(described ? { described: true } : {}),
      baseURL: familyURL(spec.data.baseURL, base),
      auth: spec.data.auth,
      gateway: spec.data.gateway === true,
      ...(spec.data.settings ? { settings: spec.data.settings } : {}),
      ...(spec.data.keys ? { keys: spec.data.keys } : {}),
      options: m.options,
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rerankers };
};
