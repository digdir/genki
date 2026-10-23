import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentId, type ParquetReader } from '@genai/ingest';
import { envSecrets } from '@genai/kernel';
import { IndexWriterRouter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { parquetReader } from '@genai/providers-parquet';
import { indexIngestionBackend } from './index-ingestion.js';
import { pipelineSpec, type IngestionJob } from './ingestion.js';

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(
      join(
        import.meta.dirname,
        '../../../packages/providers-parquet/src/fixtures',
        `${name}.parquet`,
      ),
    ),
  );
const mapping = { fields: { id: 'id', title: 'title', text: ['body'] } };
const a = 'https://data.example/a.parquet';
const b = 'https://data.example/b.parquet';
const hf = (files: string | string[], revision = 'main') => ({
  huggingface: { dataset: 'owner/data', table: 'default-train', files, revision },
});
const job = (source: object, execution = 'run-1'): IngestionJob => ({
  execution,
  target: { dataset: 'tenant/docs', endpoint: 'memory', collections: {} },
  pipeline: {
    dataset: 'tenant/docs',
    id: 'p',
    version: 1,
    by: 'test',
    at: '',
    reason: 'test',
    spec: pipelineSpec.parse({
      name: 'shards',
      source: { kind: 'parquet', mapping, ...source },
      chunking: { minimumLength: 1 },
    }),
  },
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const setup = async (send?: typeof fetch, reader: ParquetReader = parquetReader()) => {
  const root = await mkdtemp(join(tmpdir(), 'parquet-shards-test-'));
  roots.push(root);
  const engine = memoryEngine();
  const writers = new IndexWriterRouter({
    catalog: {
      endpoints: { memory: { engine: 'memory' } },
      datasets: [{ id: 'tenant/docs', endpoint: 'memory', residency: 'norway' }],
    },
    adapters: [engine.writer],
    knowledgeAdapters: [engine.adapter],
    secrets: envSecrets({}),
  });
  const fetched: string[] = [];
  const fetcher = (async (input, init) => {
    fetched.push(String(input));
    if (send) return send(input, init);
    return new Response(fixture(String(input) === a ? 'shard-a' : 'shard-b'));
  }) as typeof fetch;
  const backend = indexIngestionBackend({
    writers,
    platformTenant: 'tenant',
    residencyOf: () => undefined,
    web: { resolve: async () => ['93.184.216.34'] },
    parquet: { reader, fetch: fetcher, workingDirectory: root },
  });
  const route = writers.open('tenant/docs', { signal: new AbortController().signal });
  const documents = async () => {
    const generation = await route.writer.active(route.dataset);
    const docs = [];
    if (!route.writer.read) throw new Error('test writer must support read');
    if (generation)
      for await (const doc of route.writer.read(route.dataset, generation)) docs.push(doc);
    return docs;
  };
  return { backend, root, fetched, route, documents };
};
const signal = () => new AbortController().signal;

describe('Parquet tables through the ingestion backend and real reader', () => {
  it('reads every shard in sorted order, cleans scratch files before downloading the next, and promotes all rows', async () => {
    const state: Awaited<ReturnType<typeof setup>> = await setup((async (input) => {
      expect(await readdir(state.root)).toHaveLength(1);
      // Only this shard has a directory; a previous shard cannot occupy disk.
      return new Response(fixture(String(input) === a ? 'shard-a' : 'shard-b'));
    }) as typeof fetch);
    const report = await state.backend.run(job({ urls: [b, a], table: 'train' }), signal());
    expect(report).toMatchObject({ stored: 4, failed: [], promoted: true });
    expect(state.fetched).toEqual([a, b]);
    expect((await state.documents()).map((d) => d.id).sort()).toEqual(
      'abcd'
        .split('')
        .map((id) => documentId(`parquet://tables/train#${id}`))
        .sort(),
    );
    expect(await readdir(state.root)).toEqual([]);
  });

  it('keeps document ids when every row moves to another shard at a different revision', async () => {
    let revision = 1;
    const state = await setup(
      (async (input) =>
        new Response(
          fixture(
            `${revision === 1 ? 'shard' : 'reshard'}-${String(input).endsWith('a.parquet') ? 'a' : 'b'}`,
          ),
        )) as typeof fetch,
    );
    await state.backend.run(job(hf(['data/b.parquet', 'data/a.parquet'])), signal());
    const before = (await state.documents()).map((d) => d.id).sort();
    revision = 2;
    await state.backend.run(job(hf(['new/b.parquet', 'new/a.parquet'], 'v2'), 'run-2'), signal());
    expect((await state.documents()).map((d) => d.id).sort()).toEqual(before);
    expect(before).toHaveLength(4);
  });

  it('refuses duplicate ids across shards and preserves the previously promoted generation', async () => {
    const state = await setup((async () => new Response(fixture('shard-a'))) as typeof fetch);
    await state.backend.run(job({ url: a }, 'good'), signal());
    await expect(
      state.backend.run(job({ urls: [a, b], table: 'train' }), signal()),
    ).rejects.toThrow(/duplicate Parquet row id a in table/);
    expect(await state.route.writer.active(state.route.dataset)).toBe('good');
    expect(await readdir(state.root)).toEqual([]);
  });

  it('resolves a paginated fake Hugging Face tree, matches the glob, and sorts all resolved paths', async () => {
    const tree = 'https://huggingface.co/api/datasets/owner/data/tree/main/data';
    const state = await setup((async (input) => {
      const url = String(input);
      if (url === `${tree}?recursive=true&limit=1000`)
        return Response.json(
          [
            { type: 'file', path: 'data/train-b.parquet' },
            { type: 'directory', path: 'data/train-folder.parquet' },
            { type: 'file', path: 'data/test.parquet' },
          ],
          { headers: { link: `<${tree}?cursor=2>; rel="next"` } },
        );
      if (url === `${tree}?cursor=2`)
        return Response.json([{ type: 'file', path: 'data/train-a.parquet' }]);
      return new Response(fixture(url.endsWith('a.parquet') ? 'shard-a' : 'shard-b'));
    }) as typeof fetch);
    expect(await state.backend.run(job(hf('data/train-*.parquet')), signal())).toMatchObject({
      stored: 4,
      promoted: true,
    });
    expect(state.fetched).toEqual([
      `${tree}?recursive=true&limit=1000`,
      `${tree}?cursor=2`,
      'https://huggingface.co/datasets/owner/data/resolve/main/data/train-a.parquet',
      'https://huggingface.co/datasets/owner/data/resolve/main/data/train-b.parquet',
    ]);
  });

  it('applies maxRows across shards before filtering and never downloads shards beyond the cap', async () => {
    const state = await setup();
    const report = await state.backend.run(
      job({ urls: [b, a], table: 'train', mapping: { ...mapping, maxRows: 3 } }),
      signal(),
    );
    expect(report.stored).toBe(3);
    expect((await state.documents()).map((d) => d.title).sort()).toEqual([
      'Title a',
      'Title b',
      'Title c',
    ]);
    state.fetched.splice(0);
    expect(
      (
        await state.backend.run(
          job({ urls: [b, a], table: 'train', mapping: { ...mapping, maxRows: 1 } }, 'capped'),
          signal(),
        )
      ).stored,
    ).toBe(1);
    expect(state.fetched).toEqual([a]);
    expect(await readdir(state.root)).toEqual([]);
  });

  it('counts filtered-out rows against the total row cap', async () => {
    const state = await setup();
    const report = await state.backend.run(
      job({
        urls: [a, b],
        table: 'train',
        mapping: {
          ...mapping,
          maxRows: 3,
          filter: [{ column: 'id', op: 'neq', value: 'a' }],
        },
      }),
      signal(),
    );
    expect(report.stored).toBe(2);
    expect((await state.documents()).map((d) => d.title).sort()).toEqual(['Title b', 'Title c']);
  });

  it('writes streamed download chunks to disk before the response body finishes', async () => {
    const gate = Promise.withResolvers<undefined>();
    const bytes = fixture('shard-a');
    const first = bytes.subarray(0, 100);
    const state = await setup(
      (async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(first);
              await gate.promise;
              controller.enqueue(bytes.subarray(100));
              controller.close();
            },
          }),
        )) as typeof fetch,
    );
    const running = state.backend.run(job({ url: a }), signal());
    try {
      await vi.waitFor(async () => {
        const [directory] = await readdir(state.root);
        if (!directory) throw new Error('download must have a scratch directory');
        expect(
          new Uint8Array(await readFile(join(state.root, directory, 'shard.parquet'))),
        ).toEqual(first);
      });
    } finally {
      gate.resolve(undefined);
      await running;
    }
    expect(await readdir(state.root)).toEqual([]);
  });

  it('cleans the current shard and refuses promotion if decoding fails after earlier rows were stored', async () => {
    const real = parquetReader();
    let rows = 0;
    const state = await setup(undefined, {
      ...real,
      rows: async function* (...args) {
        for await (const row of real.rows(...args)) {
          if (++rows === 3) throw new Error('decoder failed');
          yield row;
        }
      },
    });
    await expect(
      state.backend.run(job({ urls: [a, b], table: 'train' }), signal()),
    ).rejects.toThrow('decoder failed');
    expect(rows).toBe(3);
    expect(await state.route.writer.active(state.route.dataset)).toBeUndefined();
    expect(await readdir(state.root)).toEqual([]);
  });

  it('passes a file-backed range buffer to the real decoder without buffering the file', async () => {
    const real = parquetReader();
    let checked = false;
    const state = await setup((async () => new Response(fixture('row-groups'))) as typeof fetch, {
      ...real,
      columns: async (file) => {
        expect(file).not.toBeInstanceOf(Uint8Array);
        checked = true;
        if (file instanceof Uint8Array) throw new Error('file must support byte ranges');
        const bytes = await file.slice(0, 4);
        expect(new TextDecoder().decode(bytes)).toBe('PAR1');
        return real.columns(file);
      },
    });
    const report = await state.backend.run(
      job({ url: a, mapping: { ...mapping, maxRows: 1 } }),
      signal(),
    );
    expect(report.stored).toBe(1);
    expect(checked).toBe(true);
    expect(await readdir(state.root)).toEqual([]);
  });

  it.each(['http', 'parse', 'columns', 'size', 'body'] as const)(
    'cleans temporary files and refuses promotion when a later shard fails: %s',
    async (failure) => {
      let columnCalls = 0;
      const state = await setup(
        (async (input) => {
          if (String(input) === a) return new Response(fixture('shard-a'));
          if (failure === 'http') return new Response('', { status: 503 });
          if (failure === 'parse') return new Response('not parquet');
          if (failure === 'size') return new Response(new Uint8Array(2048));
          if (failure === 'body')
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error('broken body'));
                },
              }),
            );
          return new Response(fixture('shard-b'));
        }) as typeof fetch,
        failure === 'columns'
          ? {
              ...parquetReader(),
              columns: async (file) =>
                ++columnCalls === 1 ? parquetReader().columns(file) : ['id', 'title'],
            }
          : parquetReader(),
      );
      await expect(
        state.backend.run(job({ urls: [a, b], table: 'train', maxBytes: 1024 }), signal()),
      ).rejects.toThrow(
        {
          http: /HTTP 503/,
          parse: /not a readable Parquet/,
          columns: /no column body/,
          size: /size limit/,
          body: /broken body/,
        }[failure],
      );
      expect(state.fetched).toEqual([a, b]);
      expect(await state.route.writer.active(state.route.dataset)).toBeUndefined();
      expect(await readdir(state.root)).toEqual([]);
    },
  );

  it('cleans an incomplete streamed download immediately on abort', async () => {
    const aborter = new AbortController();
    const state = await setup(
      (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
              setTimeout(() => aborter.abort(), 10);
            },
          }),
        )) as typeof fetch,
    );
    await expect(state.backend.run(job({ url: a }), aborter.signal)).rejects.toThrow();
    expect(await readdir(state.root)).toEqual([]);
    expect(await state.route.writer.active(state.route.dataset)).toBeUndefined();
  });

  it('cleans a downloaded file when iteration aborts during row decoding', async () => {
    const aborter = new AbortController();
    const real = parquetReader();
    const state = await setup(undefined, {
      ...real,
      rows: async function* (...args) {
        for await (const row of real.rows(...args)) {
          yield row;
          aborter.abort();
        }
      },
    });
    await expect(state.backend.run(job({ url: a }), aborter.signal)).rejects.toThrow();
    expect(await readdir(state.root)).toEqual([]);
    expect(await state.route.writer.active(state.route.dataset)).toBeUndefined();
  });

  it('guards every shard URL and CDN redirect, including later shards', async () => {
    const state = await setup((async (input) =>
      String(input) === a
        ? new Response(fixture('shard-a'))
        : new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1/private.parquet' },
          })) as typeof fetch);
    await expect(
      state.backend.run(job({ urls: [a, b], table: 'train' }), signal()),
    ).rejects.toThrow(/private or reserved/);
    expect(state.fetched).toEqual([a, b]);
    expect(await readdir(state.root)).toEqual([]);
    expect(await state.route.writer.active(state.route.dataset)).toBeUndefined();
  });

  it.each([{ tree: [] }, { tree: { bad: true } }])(
    'fails a glob that resolves to no files or a malformed tree: %j',
    async ({ tree }) => {
      const state = await setup((async () => Response.json(tree)) as typeof fetch);
      await expect(state.backend.run(job(hf('data/train-*.parquet')), signal())).rejects.toThrow(
        /matched no files|invalid Parquet tree/,
      );
      expect(await state.route.writer.active(state.route.dataset)).toBeUndefined();
      expect(await readdir(state.root)).toEqual([]);
    },
  );

  it('rejects pagination outside its tree before issuing another request', async () => {
    const state = await setup((async () =>
      Response.json([], {
        headers: { link: '<http://127.0.0.1/private>; rel="next"' },
      })) as typeof fetch);
    await expect(state.backend.run(job(hf('data/*.parquet')), signal())).rejects.toThrow(
      /invalid Parquet tree pagination/,
    );
    expect(state.fetched).toHaveLength(1);
  });

  it.each([
    { body: '{', link: undefined },
    { body: '[]', link: 'invalid; rel="next"' },
  ])(
    'refuses invalid tree JSON or malformed pagination instead of silently truncating the table: %j',
    async ({ body, link }) => {
      const state = await setup(
        (async () => new Response(body, { headers: link ? { link } : {} })) as typeof fetch,
      );
      await expect(state.backend.run(job(hf('data/*.parquet')), signal())).rejects.toThrow(
        /invalid Parquet tree/,
      );
      expect(await state.route.writer.active(state.route.dataset)).toBeUndefined();
    },
  );

  it('preserves existing single-file ids for both URL and Hugging Face specs', async () => {
    const state = await setup((async () => new Response(fixture('shard-a'))) as typeof fetch);
    await state.backend.run(job({ url: a }), signal());
    expect((await state.documents()).map((d) => d.id).sort()).toEqual(
      ['a', 'b'].map((id) => documentId(`${a}#${id}`)).sort(),
    );
    await state.backend.run(
      job({ huggingface: { dataset: 'owner/data', file: 'data/a.parquet' } }, 'hf'),
      signal(),
    );
    expect((await state.documents()).map((d) => d.id).sort()).toEqual(
      ['a', 'b'].map((id) => documentId(`hf://datasets/owner/data/data/a.parquet#${id}`)).sort(),
    );
  });

  it('requires one location and a stable table name for sharded sources', () => {
    for (const source of [
      { urls: [a] },
      { url: a, urls: [b], table: 'train' },
      { url: a, table: 'train' },
      { huggingface: { dataset: 'owner/data', files: 'data/*.parquet' } },
      hf('../*.parquet'),
      { urls: ['http://data.example/a.parquet'], table: 'train' },
    ]) {
      expect(
        pipelineSpec.safeParse({ name: 'p', source: { kind: 'parquet', mapping, ...source } })
          .success,
      ).toBe(false);
    }
  });
});
