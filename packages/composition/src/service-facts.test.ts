import type { ModelDescription } from '@genai/port-model';
import { describe, expect, it } from 'vitest';
import {
  organisationNameFrom,
  serviceFactsLookup,
  type ServiceFactsDeps,
} from './service-facts.js';

const published = (version: number) => ({
  version,
  definition: {} as never,
  publishedBy: 'kari@digdir.no',
  publishedAt: `2026-10-0${version}T09:30:00.000Z`,
  reason: 'intern merknad',
  files: {},
});

const model = (m: Partial<ModelDescription> & { id: string }) => m as ModelDescription;

const deps = (extra: Partial<ServiceFactsDeps> = {}): ServiceFactsDeps => ({
  definitions: () => ({
    get: async (kind, tenant, id, version) =>
      kind === 'Service' && tenant === '991825827' && id === 'ka'
        ? published(version ?? 4)
        : undefined,
  }),
  models: () => [
    model({
      id: 'foundry/gpt-4o-2m-tps',
      family: 'gpt-4o',
      deployment: 'gpt-4o-2m-tps',
      maker: 'OpenAI',
    }),
    model({ id: 'local/echo', deployment: 'echo-internal-01' }),
  ],
  organisationName: async (tenant) =>
    tenant === '991825827' ? 'Digitaliseringsdirektoratet' : undefined,
  ...extra,
});

const ask = (
  query: { capability?: string; model?: string; version?: number } = {},
  extra: Partial<ServiceFactsDeps> = {},
) =>
  serviceFactsLookup(deps(extra))(
    {
      tenant: '991825827',
      capability: query.capability ?? '991825827/ka/default',
      version: query.version ?? 3,
      model: query.model ?? 'foundry/gpt-4o-2m-tps',
    },
    new AbortController().signal,
  );

describe('the service facts lookup', () => {
  it('gives the owner, the publish date of the version the run uses, the latest version and the model family', async () => {
    expect(await ask()).toEqual({
      organisation: 'Digitaliseringsdirektoratet',
      draft: false,
      published: '2026-10-03T09:30:00.000Z',
      latest: 4,
      model: { name: 'GPT-4o', maker: 'OpenAI' },
    });
  });

  it('never names a model by its deployment, and never says who published or why', async () => {
    const found = await ask({ model: 'local/echo' });

    expect(found.model).toBeUndefined();
    expect(JSON.stringify(found)).not.toMatch(/echo-internal|kari@|intern merknad/);
  });

  it('calls a run of a draft capability a draft and reads no publish date for it', async () => {
    const found = await ask({ capability: 'platform/draft/playground/ka/0f3a' });

    expect(found).toMatchObject({ draft: true, published: undefined, latest: undefined });
  });

  it("never reads a service of another tenant than the capability's owner", async () => {
    const found = await ask({ capability: '920000000/ka/default' });

    expect(found).toMatchObject({ draft: true, published: undefined });
  });

  it('keeps the other facts when the organisation cannot be read', async () => {
    const found = await ask({}, { organisationName: () => Promise.reject(new Error('down')) });

    expect(found).toMatchObject({ organisation: undefined, published: '2026-10-03T09:30:00.000Z' });
  });

  it('uses the readable name it is given instead of the family', async () => {
    const found = await ask({}, { modelName: (m) => ({ name: `Readable ${m.family}` }) });

    expect(found.model).toEqual({ name: 'Readable gpt-4o' });
  });

  it('names the organisation from the tenant rows, so the worker answers as the API does', async () => {
    const name = organisationNameFrom({
      list: async () => [
        { orgNumber: '991825827', name: 'Digitaliseringsdirektoratet' },
        { orgNumber: '974760673' },
      ],
    });

    expect(await name('991825827')).toBe('Digitaliseringsdirektoratet');
    expect(await name('974760673')).toBeUndefined();
  });

  it('gives the readable name and maker of the family by default, so every runtime names the model alike', async () => {
    const found = await ask({}, { modelName: undefined });

    expect(found.model).toEqual({ name: 'GPT-4o', maker: 'OpenAI' });
  });
});
