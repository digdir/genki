import { z } from 'zod';
import { secretRefPattern, withoutTrailingSlashes } from '@genai/kernel';
import type { RerankAdapter } from './adapter.js';
import { failureModes, residencies, type FailureMode, type Residency } from './port.js';

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

const reranker = z.object({
  id,
  endpoint: id,
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
  api: string;
  baseURL: string;
  auth: z.infer<typeof auth>;
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
    const adapter = adapters.find((a) => a.api?.id === m.apis.rerank);
    if (!adapter?.api) {
      errors.push({
        path: `models.${index}.apis.rerank`,
        message: `no built-in implementation ${m.apis.rerank}`,
      });
      return;
    }
    const spec = connection.safeParse(endpoints[m.endpoint]);
    const base = spec.success ? spec.data.families[adapter.api.family] : undefined;
    if (!spec.success || base === undefined) {
      errors.push({
        path: `models.${index}.endpoint`,
        message: `${m.endpoint} does not offer the ${adapter.api.family} family`,
      });
      return;
    }
    const options = adapter.rerankerOptions.safeParse(m.options);
    if (!options.success) {
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
      api: adapter.api.id,
      baseURL: familyURL(spec.data.baseURL, base),
      auth: spec.data.auth,
      options: m.options,
    });
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rerankers };
};
