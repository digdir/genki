import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { decodedIdFamilies, encodeDecodedIds } from './decoded-ids.js';
import { bootPlatform, digdir } from './testkit.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
};

const searchOptions = {
  collections: { docs: 'docs', chunks: 'chunks' },
  profiles: { content: { collection: 'chunks', queryBy: ['text'], textField: 'text' } },
};

const knowledge = {
  endpoints: {
    search: {
      engine: 'typesense',
      baseURL: 'https://search.example.no',
      auth: { kind: 'api-key', secret: 'secret://env/search-key' },
    },
  },
  datasets: [
    { id: 'digdir/kudos', endpoint: 'search', residency: 'norway', options: searchOptions },
    { id: 'kudos', endpoint: 'search', residency: 'norway', options: searchOptions },
  ],
};

const boot = () => bootPlatform({ people, knowledge });

const encoded = (decoded: string, id: string) => decoded.replace(id, encodeURIComponent(id));

const families: { family: string; path: string; id: string; who: string; method?: string }[] = [
  {
    family: 'operator dataset',
    path: '/operator/datasets/digdir/kudos',
    id: 'digdir/kudos',
    who: 'drift',
  },
  {
    family: 'operator dataset pipelines',
    path: '/operator/datasets/digdir/kudos/pipelines',
    id: 'digdir/kudos',
    who: 'drift',
  },
  {
    family: 'operator dataset engine switches',
    path: '/operator/datasets/digdir/kudos/engine-switches',
    id: 'digdir/kudos',
    who: 'drift',
  },
  {
    family: 'tenant dataset',
    path: `/tenants/${digdir}/datasets/digdir/kudos`,
    id: 'digdir/kudos',
    who: 'kari',
  },
  {
    family: 'tenant dataset pipelines',
    path: `/tenants/${digdir}/datasets/digdir/kudos/pipelines`,
    id: 'digdir/kudos',
    who: 'kari',
  },
  {
    family: 'operator catalog',
    path: '/operator/catalog/dataset/digdir/kudos',
    id: 'digdir/kudos',
    who: 'drift',
  },
  {
    family: 'operator catalog versions',
    path: '/operator/catalog/model/fake/gpt/versions',
    id: 'fake/gpt',
    who: 'drift',
  },
  {
    family: 'tenant catalog versions',
    path: `/tenants/${digdir}/catalog/model/fake/gpt/versions`,
    id: 'fake/gpt',
    who: 'kari',
  },
  {
    family: 'tenant building block',
    path: `/tenants/${digdir}/building-blocks/model/fake/gpt`,
    id: 'fake/gpt',
    who: 'kari',
  },
  {
    family: 'tenant building block versions',
    path: `/tenants/${digdir}/building-blocks/model/fake/gpt/versions`,
    id: 'fake/gpt',
    who: 'kari',
  },
  {
    family: 'operator knowledge endpoint',
    path: '/operator/knowledge/endpoints/owner/search',
    id: 'owner/search',
    who: 'drift',
    method: 'DELETE',
  },
  {
    family: 'operator model endpoint',
    path: '/operator/model-endpoints/owner/fake',
    id: 'owner/fake',
    who: 'drift',
    method: 'DELETE',
  },
];

describe('ids with a slash that the ingress decoded', () => {
  it.each(families)(
    'reach the $family route unauthenticated, as the encoded form does',
    async ({ path, id, method = 'GET' }) => {
      const { app } = await boot();
      const decoded = await app.request(path, { method });
      const original = await app.request(encoded(path, id), { method });
      expect(original.status).toBe(401);
      expect(decoded.status).toBe(401);
    },
  );

  it.each(families)(
    'give the $family route the same answer as the encoded form',
    async ({ path, id, who, method = 'GET' }) => {
      const { send } = await boot();
      const reason = 'Sjekker at id med skråstrek virker';
      const original = await send(encoded(path, id), who, { method, reason });
      const decoded = await send(path, who, { method, reason });
      expect(decoded.status).toBe(original.status);
      expect(await decoded.text()).toBe(await original.text());
    },
  );

  it('find the qualified dataset, not a 404, through the decoded path', async () => {
    const { send } = await boot();
    const response = await send('/operator/datasets/digdir/kudos', 'drift');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'digdir/kudos' });
  });

  it('keep a short id followed by a sub-path as that id and sub-path', async () => {
    const { send } = await boot();
    const pipelines = await send('/operator/datasets/kudos/pipelines', 'drift');
    expect(pipelines.status).toBe(200);
    expect(await pipelines.json()).toMatchObject({ data: [] });
    const dataset = await send('/operator/datasets/kudos', 'drift');
    expect(await dataset.json()).toMatchObject({ id: 'kudos' });
  });

  it('send an unknown qualified id to the same handler as its encoded form, which finds nothing', async () => {
    const { send } = await boot();
    const decoded = await send('/operator/datasets/nobody/missing/pipelines', 'drift');
    const original = await send('/operator/datasets/nobody%2Fmissing/pipelines', 'drift');
    expect(decoded.status).toBe(404);
    expect(await decoded.text()).toBe(await original.text());
  });

  it('keep the body of a write through the decoded path', async () => {
    const { send } = await boot();
    const response = await send('/operator/catalog/dataset/digdir/kudos', 'drift', {
      method: 'PUT',
      reason: 'Endrer residens via dekodet sti',
      body: { endpoint: 'search', residency: 'eu', options: searchOptions },
    });
    expect(response.status).toBe(200);
    const stored = await send('/operator/catalog/dataset/digdir%2Fkudos', 'drift');
    expect(await stored.json()).toMatchObject({ spec: { residency: 'eu' } });
  });
});

describe('encodeDecodedIds', () => {
  it.each([
    ['/operator/datasets/digdir/kudos', '/operator/datasets/digdir%2Fkudos'],
    [
      '/operator/datasets/digdir/kudos/pipelines/docs/execute',
      '/operator/datasets/digdir%2Fkudos/pipelines/docs/execute',
    ],
    [
      `/tenants/${digdir}/datasets/${digdir}/notater/uploads/a.pdf`,
      `/tenants/${digdir}/datasets/${digdir}%2Fnotater/uploads/a.pdf`,
    ],
    ['/operator/catalog/model/fake/gpt/versions', '/operator/catalog/model/fake%2Fgpt/versions'],
    [
      `/tenants/${digdir}/building-blocks/model/fake/gpt/settings`,
      `/tenants/${digdir}/building-blocks/model/fake%2Fgpt/settings`,
    ],
    ['/operator/knowledge/endpoints/a/b', '/operator/knowledge/endpoints/a%2Fb'],
  ])('encodes %s', (decoded, expected) => {
    expect(encodeDecodedIds(decoded)).toBe(expected);
  });

  it.each([
    '/operator/datasets/digdir%2Fkudos/pipelines',
    '/operator/datasets/kudos/pipelines',
    '/operator/datasets/kudos/engine-switches/s1/activate',
    '/operator/datasets/kudos/',
    '/operator/datasets//kudos',
    `/tenants/${digdir}/datasets/kudos/enrichment/hypothetical-questions/apply`,
    `/tenants/${digdir}/building-blocks/approval-requests/r1`,
    `/tenants/${digdir}/building-blocks/unknown-kind/a/b`,
    '/operator/catalog/unknown-kind/a/b',
    `/tenants/${digdir}/services/a/b`,
    '/operator/datasets',
  ])('leaves %s as it is', (path) => {
    expect(encodeDecodedIds(path)).toBe(path);
  });

  it('knows every literal sub-path registered after an id with a slash', async () => {
    const { app } = await boot();
    const unknown: string[] = [];
    for (const route of new Set(app.routes.map((r) => r.path))) {
      const segments = route.split('/');
      for (const { prefix, subPaths } of decodedIdFamilies) {
        const fits = prefix.every((expected, i) => {
          const segment = segments[i + 1] ?? '';
          if (segment.startsWith(':'))
            return expected === undefined || typeof expected !== 'string';
          return typeof expected === 'string' ? segment === expected : expected?.has(segment);
        });
        if (!fits) continue;
        const id = segments[prefix.length + 1];
        const next = segments[prefix.length + 2];
        if (id === undefined || next === undefined || next === '*') continue;
        if (!id.startsWith(':') || !subPaths.has(next)) unknown.push(route);
      }
    }
    expect(unknown).toEqual([]);
  });
});
