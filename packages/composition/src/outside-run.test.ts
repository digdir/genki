import { describe, expect, it } from 'vitest';
import type { Event } from '@genai/contracts';
import { createGate, envSecrets, InMemoryEventLog, type PortContext } from '@genai/kernel';
import { EmbeddingRouter } from '@genai/port-embedding';
import { fakeEmbeddingAdapter } from '@genai/port-embedding/testing';
import { outsideRun, outsideRunTask } from './outside-run.js';

const tenant = '999888777';
const at = new Date('2026-11-03T10:00:00Z');

const embedders = (log: InMemoryEventLog) =>
  new EmbeddingRouter({
    gate: createGate({ outside: outsideRun(log, () => at) }),
    catalog: {
      endpoints: {
        local: {
          protocol: 'fake',
          baseURL: 'https://embed.example',
          auth: { kind: 'api-key', secret: 'secret://env/k' },
        },
      },
      models: [
        {
          id: 'local/small',
          endpoint: 'local',
          deployment: 'd',
          residency: 'norway',
          dimensions: 4,
        },
      ],
    },
    adapters: [fakeEmbeddingAdapter()],
    secrets: envSecrets({ K: 'k' }),
  });

const read = async (log: InMemoryEventLog, task: string) => {
  const events: Event[] = [];
  for await (const event of log.read(task, 0, () => false)) events.push(event);
  return events;
};

describe('calls outside a run', () => {
  it("writes kernel.gate.call and kernel.usage for a search embedding to the tenant's log for the day", async () => {
    const log = new InMemoryEventLog();
    const ctx: PortContext = {
      tenant,
      principal: { kind: 'agency-system', issuer: 'platform', subject: 'search' },
      task: 'search',
      signal: new AbortController().signal,
      meter: async () => undefined,
    };

    await embedders(log)
      .open({ kind: 'embedder', id: 'local/small' }, ctx)
      .embed(['Hva er fristen?']);

    const events = await read(log, outsideRunTask(tenant, at));
    expect(events.map((e) => [e.type, e.audience])).toEqual([
      ['kernel.usage', 'audit'],
      ['kernel.gate.call', 'audit'],
    ]);
    expect(events[0]?.data).toMatchObject({
      task: 'search',
      model: { kind: 'embedder', id: 'local/small' },
      usage: { requests: 1 },
    });
    expect(events[1]?.data).toMatchObject({ port: 'embedding', outcome: 'ok', task: 'search' });
    expect(JSON.stringify(events)).not.toContain('fristen');
  });

  it('leaves a call inside a run to the run', async () => {
    const log = new InMemoryEventLog();
    const audit: unknown[] = [];
    const ctx: PortContext = {
      tenant,
      principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
      task: 't1',
      signal: new AbortController().signal,
      meter: async () => undefined,
      audit: async (record) => {
        audit.push(record);
      },
    };

    await embedders(log).open({ kind: 'embedder', id: 'local/small' }, ctx).embed(['hei']);

    expect(audit).toHaveLength(1);
    expect(await read(log, outsideRunTask(tenant, at))).toEqual([]);
  });
});
