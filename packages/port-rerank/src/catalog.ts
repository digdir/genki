import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { secretRefPattern } from '@genai/kernel';
import type { RerankAdapter } from './adapter.js';
import { failureModes, residencies } from './port.js';

const id = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const secret = z.string().regex(secretRefPattern, 'must be a secret:// reference');

const auth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('api-key'), secret, header: z.string().min(1).optional() }),
  z.strictObject({ kind: z.literal('bearer'), secret }),
  z.strictObject({ kind: z.literal('token-provider'), provider: id }),
]);

const endpoint = z.strictObject({
  engine: id,
  baseURL: z.url({ protocol: /^https?$/ }),
  auth,
  options: z.record(z.string(), z.unknown()).default({}),
});

const reranker = z.strictObject({
  id,
  endpoint: id,
  residency: z.enum(residencies),
  onFailure: z.enum(failureModes).default('degrade'),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const rerankCatalog = z.strictObject({
  endpoints: z.record(id, endpoint),
  rerankers: z.array(reranker),
});

export type RerankCatalog = z.infer<typeof rerankCatalog>;
export type CatalogReranker = RerankCatalog['rerankers'][number];

export type RerankCatalogResult =
  { ok: true; catalog: RerankCatalog } | { ok: false; errors: { path: string; message: string }[] };

const pathOf = (base: (string | number)[], issue: { path: PropertyKey[] }) =>
  [...base, ...issue.path].map(String).join('.');

export const parseRerankCatalog = (
  input: unknown,
  adapters: RerankAdapter[],
): RerankCatalogResult => {
  const parsed = rerankCatalog.safeParse(input);
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
    const options = adapter.endpointOptions.safeParse(e.options);
    if (!options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['endpoints', name, 'options'], i), message: i.message });
    }
  }

  catalog.rerankers.forEach((r, index) => {
    if (catalog.rerankers.findIndex((other) => other.id === r.id) !== index)
      errors.push({ path: `rerankers.${index}.id`, message: `duplicate reranker ${r.id}` });
    const e = catalog.endpoints[r.endpoint];
    if (!e) {
      errors.push({
        path: `rerankers.${index}.endpoint`,
        message: `unknown endpoint ${r.endpoint}`,
      });
      return;
    }
    const options = byEngine.get(e.engine)?.rerankerOptions.safeParse(r.options);
    if (options && !options.success) {
      for (const i of options.error.issues)
        errors.push({ path: pathOf(['rerankers', index, 'options'], i), message: i.message });
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, catalog };
};

export const parseRerankCatalogYaml = (
  text: string,
  adapters: RerankAdapter[],
): RerankCatalogResult => {
  try {
    return parseRerankCatalog(parseYaml(text), adapters);
  } catch (error) {
    return {
      ok: false,
      errors: [{ path: '', message: `not valid YAML: ${(error as Error).message}` }],
    };
  }
};
