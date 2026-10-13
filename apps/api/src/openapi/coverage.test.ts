import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir } from '../testkit.js';
import { mockRoutes } from './access.js';
import { reasonFreeWrites } from '../change-reason.js';
import { keepsOwnErrorShape } from '../problem-responses.js';
import { apiTags, tagOf } from './tags.js';

type Operation = {
  tags?: string[];
  parameters?: { name?: string; in?: string; required?: boolean }[];
  responses?: Record<string, { description?: string; content?: unknown }>;
};

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
};

const operations = async () => {
  const { send } = await bootPlatform({ people, services: ['klarsprak'] });
  const doc = (await (await send('/openapi.json', 'kari')).json()) as Document;
  return operationsOf(doc);
};

type Document = {
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, Operation>>;
};

const operationsOf = (doc: Document) =>
  Object.entries(doc.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => ({ key: `${method} ${path}`, op })),
  );

const known = new Set<string>(apiTags.map((tag) => tag.name));

describe('openapi.json', () => {
  it('describes every operation instead of falling back to the placeholder', async () => {
    const placeholders = (await operations())
      .filter(({ op }) => op.responses?.default?.description === 'See the route')
      .map(({ key }) => key);
    expect(placeholders).toEqual([]);
  });

  it('gives every operation at least one response with a body schema or an empty success', async () => {
    const bare = (await operations())
      .filter(({ op }) =>
        Object.entries(op.responses ?? {}).every(
          ([status, response]) => response.content === undefined && !status.startsWith('20'),
        ),
      )
      .map(({ key }) => key);
    expect(bare).toEqual([]);
  });

  it('gives every operation exactly one known tag', async () => {
    const wrong = (await operations())
      .filter(({ op }) => op.tags?.length !== 1 || !known.has(op.tags[0] ?? ''))
      .map(({ key, op }) => `${key}: ${JSON.stringify(op.tags)}`);
    expect(wrong).toEqual([]);
  });

  it('describes every tag it uses, in the document', async () => {
    const { send } = await bootPlatform({ people, services: ['klarsprak'] });
    const doc = (await (await send('/openapi.json', 'kari')).json()) as Document;
    expect(doc.tags?.map((tag) => tag.name)).toEqual([...known]);
    expect(doc.tags?.every((tag) => (tag.description ?? '').length > 20)).toBe(true);
    const used = new Set(operationsOf(doc).flatMap(({ op }) => op.tags ?? []));
    expect([...known].filter((tag) => !used.has(tag))).toEqual([]);
  });

  it('tags the dev-only mock routes under access, and operator routes under operations', () => {
    expect(new Set(mockRoutes.map((route) => tagOf(route.path)))).toEqual(
      new Set(['Access and extensions']),
    );
    expect(tagOf('/operator/datasets/{id}/engine')).toBe('Operations');
    expect(tagOf('/tenants/{tenant}/services/{id}/draft')).toBe('Services and definitions');
    expect(tagOf('/tenants/{tenant}/services/{id}/eval-runs')).toBe('Work and quality');
    expect(tagOf('/reference')).toBe('Platform');
  });

  it('documents the change-reason header as required on every audited write', async () => {
    const free = new Set(
      Object.keys(reasonFreeWrites).map((route) => {
        const [method = '', path = ''] = route.split(' ');
        return `${method.toLowerCase()} ${path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, '{$1}')}`;
      }),
    );
    const missing = (await operations())
      .filter(({ key }) => /^(post|put|patch|delete) /.test(key) && !free.has(key))
      .filter(
        ({ op }) =>
          !op.parameters?.some(
            (p) => p.in === 'header' && p.name === 'change-reason' && p.required === true,
          ),
      )
      .map(({ key }) => key);
    expect(missing).toEqual([]);
  });

  it('documents every error response outside /v1, A2A and MCP as problem+json', async () => {
    const wrong = (await operations())
      .filter(({ key }) => !keepsOwnErrorShape(key.split(' ')[1] ?? ''))
      .flatMap(({ key, op }) =>
        Object.entries(op.responses ?? {})
          .filter(([status, response]) => /^[45]/.test(status) && response.content !== undefined)
          .filter(
            ([, response]) =>
              !Object.keys(response.content as object).includes('application/problem+json'),
          )
          .map(([status]) => `${key} ${status}`),
      );
    expect(wrong).toEqual([]);
  });
});
