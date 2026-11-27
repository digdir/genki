import { envSecrets, type PortContext } from '@genai/kernel';
import {
  memoryEngine,
  partsCases,
  partsDocuments,
  partsFiles,
  seedCorpus,
} from '@genai/port-knowledge/testing';
import { createAgentRetrieval } from '@genai/retrieval';
import { describe, expect, it } from 'vitest';
import { ContextualKnowledgeRouter, portContexts } from './knowledge-context.js';

const signal = new AbortController().signal;
const context: PortContext = {
  tenant: '991825827',
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  task: 't1',
  signal,
  meter: async () => undefined,
};

describe('knowledge opened by the runtime', () => {
  it('gives the agent the read around a hit through the router every run opens datasets with', async () => {
    const engine = memoryEngine();
    const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
    const [report, attachment] = partsFiles;
    const ids: [string, string] = [
      engine.conversions.store(report),
      engine.conversions.store(attachment),
    ];
    await seedCorpus(writer, { id: 'digdir/havn', filters: {}, options: {} }, partsDocuments(ids));
    const tenants: (string | undefined)[] = [];
    const adapter = {
      ...engine.adapter,
      connect: (...args: Parameters<typeof engine.adapter.connect>) => {
        const connection = engine.adapter.connect(...args);
        const parts = connection.parts?.bind(connection);
        if (!parts) throw new Error('the memory engine reads parts');
        return {
          ...connection,
          parts: (...read: Parameters<typeof parts>) => {
            tenants.push(portContexts.getStore()?.tenant);
            return parts(...read);
          },
        };
      },
    };
    const router = new ContextualKnowledgeRouter({
      catalog: {
        endpoints: { main: { engine: engine.adapter.engine, options: {} } },
        datasets: [
          { id: 'digdir/havn', endpoint: 'main', residency: 'norway', filters: {}, options: {} },
        ],
      },
      adapters: [adapter],
      secrets: envSecrets({}),
    });

    const knowledge = router.open({ kind: 'dataset', id: 'digdir/havn' }, context);
    const read = await createAgentRetrieval({ knowledge }).readParts?.(
      'havn-rapport-5',
      'units',
      1,
      20_000,
      signal,
    );

    expect(read?.parts.map((p) => p.seq)).toEqual([...partsCases.units.seqs]);
    expect(tenants).toEqual(['991825827']);
  });
});
