import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { restartMessage } from './background-lease.js';
import { createPlatform, platformModules } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { improvementKind } from './improvements.js';
import { createQualityModule, qualityModule } from './quality.js';
import { serviceRunKind } from './service-eval.js';

const tenant = '991825827';
const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant,
  authorizedFor: [{ org: tenant }],
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const run = (id: string, lease: { owner?: string; heartbeatAt?: string }, startedAt: string) => ({
  id,
  service: 'svar',
  status: 'running',
  testSet: 'svar-frister',
  testSetVersion: 1,
  version: 1,
  startedAt,
  endedAt: null,
  score: null,
  passed: 0,
  total: 3,
  cost: null,
  tokens: { input: 0, output: 0 },
  cases: [],
  ...lease,
});

const seed = async (entries: InMemoryConfigEntryStore) => {
  const put = (kind: string, id: string, spec: unknown) =>
    entries.append({
      kind,
      scope: tenant,
      id,
      version: 1,
      spec: spec as Record<string, unknown>,
      deleted: false,
      by: 'employee:test:kari',
      reason: 'Kjører',
      at: minutesAgo(10),
    });
  await put(
    serviceRunKind,
    'before-restart',
    run('before-restart', { owner: 'old', heartbeatAt: minutesAgo(10) }, minutesAgo(12)),
  );
  await put(serviceRunKind, 'legacy', run('legacy', {}, minutesAgo(60)));
  await put(
    serviceRunKind,
    'other-instance',
    run('other-instance', { owner: 'live', heartbeatAt: minutesAgo(0) }, minutesAgo(5)),
  );
  await put(improvementKind, 'proposal', {
    id: 'proposal',
    service: 'svar',
    status: 'running',
    testSet: 'svar-frister',
    baseVersion: 1,
    target: { path: 'spec.strategy.config.instructions' },
    change: null,
    scores: null,
    examples: [],
    reasons: [],
    createdAt: minutesAgo(12),
    owner: 'old',
    heartbeatAt: minutesAgo(10),
  });
};

const boot = async () => {
  const entries = new InMemoryConfigEntryStore();
  await seed(entries);
  const background: Promise<void>[] = [];
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    configurables: { store: entries },
    modules: [
      ...platformModules.filter((m) => m !== qualityModule),
      createQualityModule({ onBackground: (w) => background.push(w) }),
    ],
    authenticate: async () => ({ principal: kari }),
  });
  await Promise.all(background);
  const app = new Hono();
  platform.mount(
    app,
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      extensions: platform.extensions,
    }),
  );
  const get = async (path: string) =>
    (await (await app.request(path)).json()) as { data: Record<string, unknown>[] };
  return { entries, get };
};

describe('background work after a restart', () => {
  it('marks runs and proposals left running before the restart as failed, but not a live run on another instance', async () => {
    const { entries, get } = await boot();

    const latest = async (kind: string, id: string) =>
      (await entries.history(kind, tenant, id)).at(-1)?.spec as Record<string, unknown>;
    expect(await latest(serviceRunKind, 'before-restart')).toMatchObject({
      status: 'failed',
      error: restartMessage,
    });
    expect(await latest(serviceRunKind, 'legacy')).toMatchObject({
      status: 'failed',
      error: restartMessage,
    });
    expect(await latest(serviceRunKind, 'other-instance')).toMatchObject({ status: 'running' });
    expect(await latest(improvementKind, 'proposal')).toMatchObject({
      status: 'failed',
      error: restartMessage,
    });

    const runs = (await get(`/tenants/${tenant}/services/svar/eval-runs`)).data;
    expect(Object.fromEntries(runs.map((r) => [r.id, r.status]))).toEqual({
      'before-restart': 'failed',
      legacy: 'failed',
      'other-instance': 'running',
    });
    const proposals = (await get(`/tenants/${tenant}/services/svar/improvements`)).data;
    expect(proposals).toEqual([
      expect.objectContaining({ id: 'proposal', status: 'failed', error: restartMessage }),
    ]);
  });
});
