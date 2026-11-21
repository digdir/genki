import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir } from '../testkit.js';

type Operation = { responses?: Record<string, unknown> };
type Document = {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components?: Record<string, Record<string, unknown>>;
};

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
};

const isPublic = (path: string) => path === '/v1' || path.startsWith('/v1/');

const refsIn = (value: unknown, out: Set<string>) => {
  if (Array.isArray(value)) value.forEach((item) => refsIn(item, out));
  else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value))
      if (key === '$ref' && typeof inner === 'string') out.add(inner);
      else refsIn(inner, out);
};

const publicApi = (doc: Document) => {
  const paths = Object.fromEntries(Object.entries(doc.paths).filter(([path]) => isPublic(path)));
  const reached = new Set<string>();
  const pending = new Set<string>();
  refsIn(paths, pending);
  const components: Record<string, Record<string, unknown>> = {};
  while (pending.size > 0) {
    const [ref = ''] = pending;
    pending.delete(ref);
    if (reached.has(ref)) continue;
    reached.add(ref);
    const [, , section = '', name = ''] = ref.split('/');
    const found = doc.components?.[section]?.[name];
    if (found === undefined) continue;
    (components[section] ??= {})[name] = found;
    refsIn(found, pending);
  }
  const sorted = Object.fromEntries(
    Object.keys(components)
      .sort()
      .map((section) => [
        section,
        Object.fromEntries(
          Object.keys(components[section] ?? {})
            .sort()
            .map((name) => [name, components[section]?.[name]]),
        ),
      ]),
  );
  return { openapi: doc.openapi, paths, components: sorted };
};

const served = async () => {
  const booted = await bootPlatform({ people, services: ['klarsprak'] });
  const doc = (await (await booted.send('/openapi.json', 'kari')).json()) as Document;
  return { ...booted, doc };
};

const exampleOf = (path: string) =>
  path.replace(/\{hostname\}/g, 'ukjent.example.no').replace(/\{[^}]+\}/g, 'x');

describe('the public /v1 OpenAPI', () => {
  it('is committed in docs/api/openapi-v1.json exactly as the API serves it', async () => {
    const { doc } = await served();
    await expect(`${JSON.stringify(publicApi(doc), null, 2)}\n`).toMatchFileSnapshot(
      '../../../../docs/api/openapi-v1.json',
    );
  });

  it('documents a 401 on a /v1 operation exactly when it refuses a call without a credential', async () => {
    const { app, doc } = await served();
    const wrong: string[] = [];
    for (const [path, item] of Object.entries(doc.paths).filter(([p]) => isPublic(p)))
      for (const [method, operation] of Object.entries(item)) {
        const response = await app.request(exampleOf(path), {
          method: method.toUpperCase(),
          ...(method === 'post'
            ? { headers: { 'content-type': 'application/json' }, body: '{}' }
            : {}),
        });
        const documented = '401' in (operation.responses ?? {});
        if (documented !== (response.status === 401))
          wrong.push(`${method} ${path}: documents 401 ${documented}, answers ${response.status}`);
      }
    expect(wrong).toEqual([]);
  });
});
