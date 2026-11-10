import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTestSetYaml, perCaseMeans } from '@genai/eval';
import { describe, expect, it } from 'vitest';
import { appendVersion, InMemoryConfigEntryStore } from './config-store.js';
import { evalRunFromServiceRun, portalGateRuns } from './gate-runs.js';
import { serviceRunKind, type ServiceRun } from './service-eval.js';

const set = parseTestSetYaml(
  readFileSync(
    join(import.meta.dirname, '../../../packages/jobs/examples/testsets/nynorsk-referanse.yaml'),
    'utf8',
  ),
);
const tenant = set.metadata.tenant;

const portalRun = (overrides: Partial<ServiceRun> = {}): ServiceRun => ({
  id: 'run-1',
  service: 'nynorsk',
  status: 'succeeded',
  testSet: set.metadata.id,
  testSetVersion: set.metadata.version,
  version: 'draft',
  subject: 'spec:draft',
  startedAt: '2026-11-02T13:41:00.000Z',
  endedAt: '2026-11-02T13:42:00.000Z',
  score: 1,
  passed: set.spec.cases.length,
  total: set.spec.cases.length,
  cost: null,
  tokens: { input: 0, output: 0 },
  cases: set.spec.cases.map((c) => ({
    caseId: c.id,
    input: String(c.input),
    expected: c.expected.referenceAnswer ?? '',
    type: 'criteria',
    split: 'open',
    output: c.expected.referenceAnswer ?? '',
    pass: true,
  })),
  ...overrides,
});

const stored = async (...runs: ServiceRun[]) => {
  const entries = new InMemoryConfigEntryStore();
  for (const run of runs)
    await appendVersion<ServiceRun>(entries, {
      kind: serviceRunKind,
      scope: tenant,
      id: run.id,
      spec: run,
      deleted: false,
      by: 'nikolai',
      reason: 'Testkjøring',
    });
  return entries;
};

const testSets = { get: async () => set };

describe('portal test runs as gate evidence', () => {
  it('scores nynorsk.chrf from the answers a portal test run stored, on the test set splits', async () => {
    const run = await evalRunFromServiceRun(portalRun(), set);

    const validation = [...perCaseMeans(run, 'nynorsk.chrf', undefined, 'validation').values()];
    expect(validation.length).toBeGreaterThan(0);
    expect(validation.every((v) => v > 0.99)).toBe(true);
  });

  it('counts only a succeeded portal run of the same draft on a listed test set', async () => {
    const entries = await stored(
      portalRun({ id: 'old-draft', subject: 'spec:older' }),
      portalRun({ id: 'failed', status: 'failed' }),
      portalRun({ id: 'other-set', testSet: 'klarsprak-brev' }),
    );

    const none = await portalGateRuns(entries, testSets, tenant, 'nynorsk', 'spec:draft', [
      set.metadata.id,
    ]);
    await appendVersion<ServiceRun>(entries, {
      kind: serviceRunKind,
      scope: tenant,
      id: 'this-draft',
      spec: portalRun({ id: 'this-draft' }),
      deleted: false,
      by: 'nikolai',
      reason: 'Testkjøring',
    });
    const found = await portalGateRuns(entries, testSets, tenant, 'nynorsk', 'spec:draft', [
      set.metadata.id,
    ]);

    expect(none.size).toBe(0);
    expect(found.get(set.metadata.id)?.id).toBe('this-draft');
  });
});
