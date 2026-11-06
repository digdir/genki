import { describe, expect, it, vi } from 'vitest';
import { InMemoryDefinitionStore } from '@genai/definitions';
import {
  envSecrets,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryTaskStore,
  type PortContext,
} from '@genai/kernel';
import { createRuntime } from './runtime.js';
import { TenantSecretVault } from './tenant-secrets.js';

const question = 'Hva er fristen for klage på vedtaket?';
const providerText = 'Requests to the Embeddings_Create Operation have exceeded the call rate';

const throttled = () =>
  new Response(JSON.stringify({ error: { code: '429', message: providerText } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after-ms': '5' },
  });

const embedded = () =>
  Response.json({
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
    model: 'text-embedding-3-large',
    usage: { prompt_tokens: 9, total_tokens: 9 },
  });

const runtimeWith = async (
  answers: (attempt: number) => Response,
  request?: { retries?: number },
) => {
  const lines: Record<string, unknown>[] = [];
  const logger = (msg: string, fields: Record<string, unknown>) => lines.push({ msg, ...fields });
  const attempts: { linesBefore: number }[] = [];
  const fake: typeof fetch = async () => {
    attempts.push({ linesBefore: lines.length });
    return answers(attempts.length);
  };
  const runtime = await createRuntime({
    platformTenant: '991825827',
    catalogs: {
      models: {
        endpoints: {
          foundry: {
            baseURL: 'https://foundry.example/openai/v1',
            auth: { kind: 'api-key', secret: 'secret://env/foundry-key' },
            families: { openai: '' },
          },
        },
        models: [
          {
            id: 'foundry/text-embedding-3-large',
            endpoint: 'foundry',
            deployment: 'text-embedding-3-large',
            residency: 'norway',
            apis: { embed: 'openai/embeddings@1' },
            embed: { dimensions: 4 },
          },
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ FOUNDRY_KEY: 'k' }),
    vault: new TenantSecretVault(),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) } as never,
    log: new InMemoryEventLog(),
    tasks: new InMemoryTaskStore(),
    state: new InMemoryStateStore(),
    logger,
    endpointFetch: (endpoint) => (endpoint === 'foundry' ? fake : undefined),
  });
  const ctx: PortContext = {
    tenant: '991825827',
    principal: { kind: 'agency-system', issuer: 'platform', subject: 'knowledge' },
    task: 'knowledge-run-1',
    signal: new AbortController().signal,
    meter: async () => undefined,
  };
  const embedder = runtime.embedders.open(
    { kind: 'embedder', id: 'foundry/text-embedding-3-large' },
    ctx,
    request,
  );
  return { embedder, lines, attempts };
};

describe('model calls in the log', () => {
  it('a throttled model call is logged with the wait the provider asked for before it is retried', async () => {
    const { embedder, lines, attempts } = await runtimeWith((n) =>
      n === 1 ? throttled() : embedded(),
    );

    await embedder.embed([question]);

    expect(lines.filter((l) => l.msg === 'model call throttled')).toEqual([
      {
        msg: 'model call throttled',
        endpoint: 'foundry',
        model: 'text-embedding-3-large',
        status: 429,
        retryAfterMs: 5,
        attempt: 1,
      },
    ]);
    expect(attempts[1]?.linesBefore).toBeGreaterThan(attempts[0]?.linesBefore ?? 0);
    expect(JSON.stringify(lines)).not.toContain('fristen');
    expect(JSON.stringify(lines)).not.toContain('exceeded the call rate');
  });

  it('a failed embedding call is logged with its code', async () => {
    const { embedder, lines } = await runtimeWith(() => throttled());

    await expect(embedder.embed([question])).rejects.toMatchObject({ code: 'rate_limited' });

    await vi.waitFor(() =>
      expect(lines.filter((l) => l.msg === 'model call failed')).toEqual([
        {
          msg: 'model call failed',
          task: 'knowledge-run-1',
          tenant: '991825827',
          model: 'foundry/text-embedding-3-large',
          error: 'EmbeddingError',
          code: 'rate_limited',
        },
      ]),
    );
    expect(lines.filter((l) => l.msg === 'model call throttled').map((l) => l.attempt)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(JSON.stringify(lines)).not.toContain('fristen');
    expect(JSON.stringify(lines)).not.toContain('exceeded the call rate');
  });

  it('a 429 on an embedder that retries itself is logged as throttled, never as a failed call', async () => {
    const { embedder, lines } = await runtimeWith(() => throttled(), { retries: 0 });

    await expect(embedder.embed([question])).rejects.toMatchObject({ code: 'rate_limited' });

    await new Promise((r) => setTimeout(r, 20));
    expect(lines.filter((l) => l.msg === 'model call throttled')).toHaveLength(1);
    expect(lines.filter((l) => l.msg === 'model call failed')).toEqual([]);
  });

  it('a 5xx on an embedder that retries itself is left for its caller to log', async () => {
    const { embedder, lines } = await runtimeWith(
      () => Response.json({ error: { message: 'down' } }, { status: 503 }),
      { retries: 0 },
    );

    await expect(embedder.embed([question])).rejects.toMatchObject({ code: 'unavailable' });

    await new Promise((r) => setTimeout(r, 20));
    expect(lines.filter((l) => l.msg === 'model call failed')).toEqual([]);
  });
});
