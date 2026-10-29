import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import {
  InMemoryCandidateStore,
  InMemoryEvalRunStore,
  InMemoryFeedbackStore,
  InMemoryTestSetStore,
  type EvalRun,
} from '@genai/eval';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { restartMessage } from './background-lease.js';
import { createPlatform, platformModules } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { improvementKind } from './improvements.js';
import { createQualityModule, qualityModule } from './quality.js';

const tenant = '991825827';
const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant,
  authorizedFor: [{ org: tenant }],
};

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const run = (
  id: string,
  lease: { owner?: string; heartbeatAt?: string },
  startedAt: string,
): EvalRun => ({
  id,
  testSet: { tenant, id: 'svar-frister', version: 1 },
  capability: 'draft/builder/abc',
  splits: ['train', 'validation', 'holdout'],
  repeats: 1,
  startedAt,
  endedAt: startedAt,
  provenance: { commit: 'dev', data: 'live', servedModels: [], judges: [], services: [] },
  results: [],
  metrics: {},
  byTag: {},
  incomplete: [],
  status: 'running',
  tested: { version: 1 },
  ...lease,
});

const seed = async (entries: InMemoryConfigEntryStore, runs: InMemoryEvalRunStore) => {
  const stored = (r: EvalRun) => runs.save({ run: r, tenant, task: '', service: 'svar' });
  await stored(
    run('before-restart', { owner: 'old', heartbeatAt: minutesAgo(10) }, minutesAgo(12)),
  );
  await stored(run('legacy', {}, minutesAgo(60)));
  await stored(run('other-instance', { owner: 'live', heartbeatAt: minutesAgo(0) }, minutesAgo(5)));
  await entries.append({
    kind: improvementKind,
    scope: tenant,
    id: 'proposal',
    version: 1,
    spec: {
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
    },
    deleted: false,
    by: 'employee:test:kari',
    reason: 'Kjører',
    at: minutesAgo(10),
  });
};

const boot = async () => {
  const entries = new InMemoryConfigEntryStore();
  const runs = new InMemoryEvalRunStore();
  await seed(entries, runs);
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
    evalStores: {
      testSets: new InMemoryTestSetStore(),
      runs,
      feedback: new InMemoryFeedbackStore(),
      candidates: new InMemoryCandidateStore(),
    },
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
  return { entries, runs, get };
};

describe('background work after a restart', () => {
  it('marks test runs and proposals left running before the restart as interrupted or failed, but not a live run on another instance', async () => {
    const { entries, runs, get } = await boot();

    const listed = (await get(`/tenants/${tenant}/services/svar/eval-runs`)).data;
    const latest = async (kind: string, id: string) =>
      (await entries.history(kind, tenant, id)).at(-1)?.spec as Record<string, unknown>;

    expect(Object.fromEntries(listed.map((r) => [r.id, r.status]))).toEqual({
      'before-restart': 'interrupted',
      legacy: 'interrupted',
      'other-instance': 'running',
    });
    expect((await runs.get('before-restart'))?.run).toMatchObject({
      status: 'interrupted',
      error: restartMessage,
    });
    expect((await runs.get('other-instance'))?.run.status).toBe('running');
    expect(await latest(improvementKind, 'proposal')).toMatchObject({
      status: 'failed',
      error: restartMessage,
    });
    const proposals = (await get(`/tenants/${tenant}/services/svar/improvements`)).data;
    expect(proposals).toEqual([
      expect.objectContaining({ id: 'proposal', status: 'failed', error: restartMessage }),
    ]);
  });
});
