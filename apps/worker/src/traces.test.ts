import { describe, expect, it } from 'vitest';
import type { Event, Task } from '@genai/contracts';
import { platformSettings, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createTraceExporter } from '@genai/providers-langfuse';
import { workerTraceDeps } from './traces.js';

const tenant = '991825827';
const runs = 40;

const exported = async (rate: number | undefined, status: 'completed' | 'failed') => {
  const settings = new SettingsRegistry(platformSettings);
  if (rate !== undefined) settings.setTenant(tenant, 'tracing.sampleRate', rate);
  const tasks = new Map<string, Task>();
  const traces = createTraceExporter(
    { endpoint: 'https://traces.example.no' },
    workerTraceDeps({
      secrets: envSecrets({}),
      tasks: async (id) => tasks.get(id),
      settings,
      fetch: async () => new Response(null, { status: 200 }),
    }),
  );
  for (let i = 0; i < runs; i++) {
    const id = `${status}-${i}`;
    tasks.set(id, {
      id,
      tenant,
      owner: tenant,
      status,
      principal: { kind: 'employee', id: 'kari' },
      service: {
        capability: { id: `${tenant}/klarsprak/default`, version: '1' },
        strategy: { id: 'single-call', version: '1' },
        configHash: 'h',
      },
      artifacts: [],
      createdAt: '2026-11-18T10:00:00Z',
    } as unknown as Task);
    traces.observe(
      {
        task: id,
        seq: 1,
        type: 'kernel.task.status',
        v: 1,
        ts: '2026-11-18T10:00:01Z',
        actor: { kind: 'kernel', id: 'kernel' },
        audience: 'audit',
        data: { status },
      } as unknown as Event,
      { tenant } as never,
    );
  }
  await traces.shutdown();
  return runs - traces.stats().sampledOut;
};

describe('worker traces', () => {
  it("samples a tenant's successful worker runs at the tenant's own rate, and always traces a failed one", async () => {
    const atPlatformRate = await exported(undefined, 'completed');
    const atTenantRate = await exported(0.1, 'completed');
    const failed = await exported(0.1, 'failed');

    expect(atPlatformRate).toBe(runs);
    expect(atTenantRate).toBeLessThan(runs / 2);
    expect(failed).toBe(runs);
  });
});
