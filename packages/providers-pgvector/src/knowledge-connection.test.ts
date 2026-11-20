import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  KnowledgeError,
  parseKnowledgeCatalog,
  type DatasetConfig,
  type IndexWriter,
  type KnowledgeAdapter,
} from '@genai/port-knowledge';
import {
  pgvectorEngine,
  type PgvectorDatasetOptions,
  type PgvectorEngineOptions,
} from './index.js';

const fakePool = () => {
  const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  const connect = vi.fn(async () => ({ query, release: () => undefined }));
  return { pool: { query, connect } as unknown as Pool, query, connect };
};

const signal = new AbortController().signal;
const dataset: DatasetConfig<PgvectorDatasetOptions> = {
  id: 'digdir/kudos',
  filters: {},
  options: {},
};
const knowledgeEndpoint = { options: { connection: 'knowledge' as const }, timeoutMs: 5000 };

const everyCall = async (engine: ReturnType<typeof pgvectorEngine>) => {
  const connection = engine.adapter.connect(knowledgeEndpoint as never);
  const writer = engine.writer.connect(knowledgeEndpoint, { signal }) as IndexWriter;
  const calls: [string, () => Promise<unknown>][] = [
    ['search', () => connection.search(dataset, [{ query: 'lønn' }], signal)],
    ['fetch', () => connection.fetch(dataset, ['a'], signal)],
    ['range', () => connection.range(dataset, 'a', 0, 2, signal)],
    ['facets', () => connection.facets(dataset, ['type'], {}, signal)],
    ['prepare', () => writer.prepare(dataset, 'g1')],
    ['store', () => writer.store(dataset, 'g1', { id: 'a', fields: {}, chunks: [], phrases: [] })],
    ['promote', () => writer.promote(dataset, 'g1')],
    ['drop', () => writer.drop(dataset, 'g1')],
    ['active', () => writer.active(dataset)],
    ['stats', () => writer.stats(dataset, 'g1')],
    [
      'read',
      async () => {
        for await (const _ of writer.read?.(dataset, 'g1') ?? []) return;
      },
    ],
  ];
  const outcomes: Record<string, unknown> = {};
  for (const [name, call] of calls)
    outcomes[name] = await call().then(
      () => 'answered',
      (error: unknown) =>
        error instanceof KnowledgeError ? `${error.code}: ${error.message}` : String(error),
    );
  return outcomes;
};

describe('a pgvector endpoint on the knowledge server', () => {
  it('a `knowledge` endpoint reads and writes only the knowledge server', async () => {
    const reader = fakePool();
    const writer = fakePool();
    const owner = fakePool();
    const engine = pgvectorEngine({
      knowledge: { reader: reader.pool, writer: writer.pool, owner: owner.pool },
    });
    await everyCall(engine);
    await engine.adapter.probe?.(knowledgeEndpoint as never, signal);
    expect(reader.query.mock.calls.length + writer.query.mock.calls.length).toBeGreaterThan(0);
  });

  it('a knowledge connection refuses a dataset the router did not hand it', async () => {
    const reader = fakePool();
    const engine = pgvectorEngine({ knowledge: { reader: reader.pool } });
    const connection = engine.adapter.connect(knowledgeEndpoint as never);
    const unrouted = { ...dataset, generation: 'g-1' };
    const other = { ...unrouted, allowed: ['digdir/annet'] };
    const outcomes = await Promise.all(
      [unrouted, other].flatMap((d) =>
        [
          () => connection.search(d, [{ query: 'lønn' }], signal),
          () => connection.fetch(d, ['a'], signal),
          () => connection.range(d, 'a', 0, 2, signal),
          () => connection.facets(d, ['type'], {}, signal),
          () => connection.documents?.(d, {}, signal) ?? Promise.resolve(),
        ].map((call) =>
          call().then(
            () => 'answered',
            (error: unknown) => (error instanceof KnowledgeError ? error.code : String(error)),
          ),
        ),
      ),
    );
    expect(new Set(outcomes)).toEqual(new Set(['forbidden']));
    expect(reader.connect).not.toHaveBeenCalled();
    expect(reader.query).not.toHaveBeenCalled();
  });

  it('reports a cancelled statement as a timeout', async () => {
    const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const query = vi.fn(async (sql: string) => {
      if (/^(begin|commit|rollback|select set_config)/.test(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes('kn_generation')) return { rows: [{ recipe: {} }], rowCount: 1 };
      throw cancelled;
    });
    const reader = { connect: vi.fn(async () => ({ query, release: () => undefined })), query };
    const engine = pgvectorEngine({ knowledge: { reader: reader as unknown as Pool } });
    const connection = engine.adapter.connect(knowledgeEndpoint as never);
    const routed = { ...dataset, generation: 'g-1', allowed: [dataset.id] };

    const failure = await connection
      .search(routed, [{ query: 'lønn', profile: 'content' }], signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(KnowledgeError);
    expect(failure).toMatchObject({
      code: 'timeout',
      message: 'reading digdir/kudos was stopped by its statement timeout',
    });
  });

  it('saving or probing a `knowledge` endpoint without a knowledge server is refused', async () => {
    const options: PgvectorEngineOptions = {};
    const engine = pgvectorEngine(options);
    const parsed = parseKnowledgeCatalog(
      {
        endpoints: { knowledge: { engine: 'pgvector', options: { connection: 'knowledge' } } },
        datasets: [],
      },
      [engine.adapter as KnowledgeAdapter],
    );
    expect(parsed).toMatchObject({
      ok: false,
      errors: [
        {
          path: 'endpoints.knowledge.options.connection',
          message: 'no knowledge server configured',
        },
      ],
    });
    await expect(engine.adapter.probe?.(knowledgeEndpoint as never, signal)).rejects.toThrow(
      'no knowledge server configured',
    );
    expect(() => engine.adapter.connect(knowledgeEndpoint as never)).toThrow(
      'no knowledge server configured',
    );
    expect(() => engine.writer.connect(knowledgeEndpoint, { signal })).toThrow(
      'no knowledge server configured',
    );
  });

  it('a `knowledge` writer refuses to start while the knowledge server is bound to another platform server', () => {
    const engine = pgvectorEngine({
      knowledge: { writer: fakePool().pool },
      knowledgeGuard: () => {
        throw new Error('the knowledge server is bound to platform server b, not a');
      },
    });
    expect(() => engine.writer.connect(knowledgeEndpoint, { signal })).toThrow(
      new KnowledgeError(
        'unavailable',
        'the knowledge server is bound to platform server b, not a',
      ),
    );
  });
});
