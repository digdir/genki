import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import type { ServiceDefinition } from '@genai/definitions';
import type { InvocationContext, Strategy } from '@genai/kernel';
import {
  adoptionKind,
  attachRuntimeBlocks,
  runtimeBlocksOf,
  withBlockSettings,
  type BlockTexts,
} from './block-settings.js';
import { InMemoryConfigEntryStore } from './config-store.js';

const tenant = '991825827';
const texts: BlockTexts = {
  disabled: (name) => `av: ${name}`,
  toolTimedOut: (seconds) => `tid: ${seconds}`,
};
const definition = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 's', name: 'S' },
  spec: {
    purpose: 'p',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1 },
    model: { primary: 'foundry-openai/gpt-4o-mini' },
    knowledge: { datasets: [{ dataset: 'digdir/kudos' }] },
    tools: [],
    skills: [],
    guardrails: {},
  },
} as unknown as ServiceDefinition;

const lookups = {
  flowSteps: async () => [],
  resolveDataset: (id: string) => id,
  datasetEndpoint: () => 'kudos-typesense',
  sharedTools: async () => new Map<string, string>(),
};

const store = async (settings: Record<string, unknown>) => {
  const entries = new InMemoryConfigEntryStore();
  await entries.append({
    kind: adoptionKind,
    scope: tenant,
    id: 'model:foundry-openai/gpt-4o-mini',
    version: 1,
    spec: { status: 'in_use', settings },
    deleted: false,
    by: 'test',
    at: new Date().toISOString(),
    reason: 'test',
  });
  return entries;
};

const run = async (entries: InMemoryConfigEntryStore) => {
  const blocks = await runtimeBlocksOf(definition, lookups);
  const inner: Strategy<Record<string, unknown>> = {
    id: 'x',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* () {
      yield { type: 'kernel.result', data: [] };
    },
  };
  const capability = attachRuntimeBlocks(
    {
      descriptor: {} as never,
      strategy: { id: 'x', version: '1' },
      config: {},
      grants: [],
    },
    tenant,
    blocks,
  );
  const wrapped = withBlockSettings(entries, inner, texts);
  const principal: Principal = { kind: 'agency-system', issuer: 'w', subject: 'w', tenant };
  const ctx = { principal, tenant } as unknown as InvocationContext;
  const out = [];
  for await (const e of wrapped.run(ctx, {}, capability.config as Record<string, unknown>))
    out.push(e);
  return { out };
};

describe('building block settings outside the API', () => {
  it('lists the model, dataset and search engine blocks a service uses', async () => {
    const blocks = await runtimeBlocksOf(definition, lookups);

    expect(blocks.map((b) => b.key)).toEqual([
      'model:foundry-openai/gpt-4o-mini',
      'dataset:digdir/kudos',
      `dataset:${tenant}/digdir/kudos`,
      'search_engine:kudos-typesense',
    ]);
  });

  it('refuses a run that uses a block the agency has turned off', async () => {
    await expect(run(await store({ enabled: false }))).rejects.toMatchObject({
      code: 'forbidden',
      message: 'av: foundry-openai/gpt-4o-mini',
    });
  });

  it('runs a service whose blocks are on and hides the block list from the strategy', async () => {
    const { out } = await run(await store({ enabled: true }));

    expect(out).toHaveLength(1);
  });
});
