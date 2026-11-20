import { parseKnowledgeCatalog, type KnowledgeAdapter } from '@genai/port-knowledge';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { pgvectorEngine } from './index.js';

const fakePool = () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const connect = vi.fn(async () => ({ query, release: () => undefined }));
  return { pool: { query, connect } as unknown as Pool, query, connect };
};

const parse = (options?: Record<string, unknown>) =>
  parseKnowledgeCatalog(
    {
      endpoints: { kunnskap: { engine: 'pgvector', ...(options ? { options } : {}) } },
      datasets: [],
    },
    [pgvectorEngine({ knowledge: { reader: fakePool().pool } }).adapter as KnowledgeAdapter],
  );

describe('pgvector endpoint options', () => {
  it('an endpoint with connection platform is refused', () => {
    const result = parse({ connection: 'platform' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('endpoints.kunnskap.options.connection');
  });

  it('an endpoint with an external connection is refused', () => {
    const result = parse({ connection: 'postgres://bruker:hemmelig@db.example.no/kunnskap' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('endpoints.kunnskap.options.connection');
  });

  it('a pgvector endpoint without a connection uses the knowledge server', async () => {
    expect(parse().ok).toBe(true);
    const reader = fakePool();
    const { adapter } = pgvectorEngine({ knowledge: { reader: reader.pool } });
    const options = adapter.endpointOptions.parse(undefined);
    expect(options).toEqual({ connection: 'knowledge' });
    await adapter.probe?.({ options, timeoutMs: 5000 } as never, new AbortController().signal);
    expect(reader.query).toHaveBeenCalledWith('select 1');
  });
});
