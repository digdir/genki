import type { EvalRun, Evaluator, TestSet, TestSetStore } from '@genai/eval';
import { klarsprakChecklist, nynorskReference } from '@genai/jobs';
import type { ConfigEntryStore } from './config-store.js';
import { serviceRunKind, type ServiceRun } from './service-eval.js';

export const gateMetricEvaluators = (): Evaluator[] => [nynorskReference(), klarsprakChecklist()];

export const portalGateMetrics = ['nynorsk.chrf', 'klarsprak.overall'];

const noModels = { servedModels: [], modelFamily: () => undefined };

export const evalRunFromServiceRun = async (
  run: ServiceRun,
  set: TestSet,
  evaluators: Evaluator[] = gateMetricEvaluators(),
): Promise<EvalRun> => {
  const cases = new Map(set.spec.cases.map((c) => [c.id, c]));
  const results: EvalRun['results'] = [];
  for (const result of run.cases) {
    const testCase = cases.get(result.caseId);
    if (!testCase) continue;
    const observation = { answer: result.output, retrieved: [], citations: [] };
    const scores = (
      await Promise.all(evaluators.map((e) => e.evaluate(testCase, observation, noModels)))
    ).flat();
    results.push({
      case: testCase.id,
      split: testCase.split,
      repeat: 0,
      task: run.id,
      tags: testCase.tags,
      ...(testCase.language ? { language: testCase.language } : {}),
      scores,
    });
  }
  return {
    id: run.id,
    testSet: { tenant: set.metadata.tenant, id: set.metadata.id, version: set.metadata.version },
    capability: run.service,
    splits: [...new Set(results.map((r) => r.split))],
    repeats: 1,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? run.startedAt,
    provenance: {
      commit: 'portal-test-run',
      data: `${set.metadata.id}@${set.metadata.version}`,
      servedModels: ['recorded-in-service-run'],
      judges: [],
      services: [run.service],
    },
    results,
    metrics: {},
    byTag: {},
    incomplete: [],
  };
};

export const portalGateRuns = async (
  entries: ConfigEntryStore,
  testSets: Pick<TestSetStore, 'get'>,
  tenant: string,
  service: string,
  subject: string,
  sets: string[],
): Promise<Map<string, EvalRun>> => {
  const runs = (await entries.latest({ kind: serviceRunKind, scope: tenant }))
    .map((e) => e.spec as ServiceRun)
    .filter(
      (r) =>
        r.service === service &&
        r.subject === subject &&
        r.status === 'succeeded' &&
        // A run of a few marked cases does not show how the whole test set does.
        !r.selected &&
        sets.includes(r.testSet),
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const found = new Map<string, EvalRun>();
  for (const run of runs) {
    if (found.has(run.testSet)) continue;
    const set = await testSets.get(tenant, run.testSet, run.testSetVersion);
    if (set) found.set(run.testSet, await evalRunFromServiceRun(run, set));
  }
  return found;
};
