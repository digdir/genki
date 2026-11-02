import { describe, expect, it } from 'vitest';
import { datasetName, langfuseDatasets } from './datasets.js';

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

/** Langfuse's stable dataset routes: a dataset is read by its name, and a POST upserts by name. */
const fakeLangfuse = (names: Record<string, string> = {}, down = false) => {
  const datasets = new Map(Object.entries(names));
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}) });
    if (down) return new Response('{}', { status: 503 });
    const named = /^\/api\/public\/v2\/datasets\/(.+)$/.exec(url.pathname)?.[1];
    if (method === 'GET' && named) {
      const name = decodeURIComponent(named);
      const id = datasets.get(name);
      return id
        ? Response.json({ id, name, description: 'Etatens egen beskrivelse' })
        : Response.json({ message: 'Dataset not found' }, { status: 404 });
    }
    if (method === 'POST' && url.pathname === '/api/public/v2/datasets') {
      const name = String(body?.name);
      const id = datasets.get(name) ?? `ds-${datasets.size + 1}`;
      datasets.set(name, id);
      return Response.json({ id, name });
    }
    return Response.json({}, { status: 404 });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls, datasets };
};

const api = (fake: ReturnType<typeof fakeLangfuse>) =>
  langfuseDatasets({
    host: 'https://langfuse.etaten.example.no',
    publicKey: 'pk',
    secretKey: 'sk',
    fetch: fake.fetch,
  });

describe('Langfuse datasets', () => {
  it('names the dataset genki/<service>/<test set>, with ids only', () => {
    expect(datasetName('klarsprak', 'klarsprak-brev')).toBe('genki/klarsprak/klarsprak-brev');
  });

  it('reuses a dataset that already has the name, without writing to it', async () => {
    const fake = fakeLangfuse({ 'genki/klarsprak/klarsprak-brev': 'ds-etaten' });

    const found = await api(fake).ensure('genki/klarsprak/klarsprak-brev');

    expect(found).toEqual({ id: 'ds-etaten', name: 'genki/klarsprak/klarsprak-brev' });
    expect(fake.calls.map((c) => c.method)).toEqual(['GET']);
    expect(fake.calls[0]?.path).toBe('/api/public/v2/datasets/genki%2Fklarsprak%2Fklarsprak-brev');
  });

  it('creates an empty dataset when Langfuse has none by the name', async () => {
    const fake = fakeLangfuse();

    const made = await api(fake).ensure('genki/klarsprak/klarsprak-brev');

    expect(made).toEqual({ id: 'ds-1', name: 'genki/klarsprak/klarsprak-brev' });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/public/v2/datasets/genki%2Fklarsprak%2Fklarsprak-brev',
      'POST /api/public/v2/datasets',
    ]);
    // No items go with it: the cases stay in genki.
    expect(Object.keys(fake.calls[1]?.body as object).sort()).toEqual(['description', 'name']);
    expect(fake.calls.some((c) => c.path.includes('dataset-items'))).toBe(false);
  });

  it("fails when Langfuse can't be read, rather than creating a dataset it may already have", async () => {
    const fake = fakeLangfuse({}, true);

    await expect(api(fake).ensure('genki/klarsprak/klarsprak-brev')).rejects.toThrow(
      'Langfuse answered HTTP 503',
    );
    expect(fake.calls.map((c) => c.method)).toEqual(['GET']);
  });
});

const host = process.env.LANGFUSE_LOCAL_URL;
const publicKey = process.env.LANGFUSE_LOCAL_PUBLIC_KEY ?? 'pk-lf-genki-test';
const secretKey = process.env.LANGFUSE_LOCAL_SECRET_KEY ?? 'sk-lf-genki-test';

describe.skipIf(!host)('Langfuse datasets on a local Langfuse', () => {
  it('finds the same dataset by its name every time', async () => {
    const datasets = langfuseDatasets({ host: host as string, publicKey, secretKey });
    const name = datasetName('klarsprak', 'klarsprak-brev');

    const first = await datasets.ensure(name);
    const again = await datasets.ensure(name);

    expect(again).toEqual(first);
    expect(first.name).toBe(name);
  });
});
