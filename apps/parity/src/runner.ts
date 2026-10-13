import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareCaptured, type Difference } from './compare.js';
import {
  divergenceFor,
  divergences as agreed,
  meetsExpectation,
  type Divergence,
} from './divergences.js';
import { send } from './http.js';
import { newToOld, parityScope, renamed } from './scope.js';
import type {
  Captured,
  Mode,
  Needs,
  Recording,
  Scenario,
  Side,
  StepResult,
  Target,
} from './types.js';

export type Outcome = 'pass' | 'fail' | 'divergence' | 'skipped' | 'missing' | 'error' | 'not-run';

export interface ScenarioReport {
  scenario: string;
  title: string;
  outcome: Outcome;
  differences: (Difference & { step: string })[];
  error?: string;
  divergence?: string;
  needs?: Needs[];
  ranAt?: string;
}

const redact = (result: StepResult): StepResult => {
  const headers = { ...result.request.headers };
  delete headers['x-api-key'];
  delete headers['X-API-Key'];
  return { ...result, request: { ...result.request, headers } };
};

export const runScenario = async (
  target: Target,
  scenario: Scenario,
  side: Side,
): Promise<StepResult[]> => {
  const results: StepResult[] = [];
  for (const step of scenario.steps) {
    const request = step.request(results, side);
    results.push({ request, response: await send(target, request) });
  }
  return results;
};

const fixturePath = (dir: string, id: string) => join(dir, `${id}.json`);

export const record = async (
  target: Target,
  scenarios: Scenario[],
  dir: string,
  side: Side = 'old',
) => {
  await mkdir(dir, { recursive: true });
  const outcomes: { scenario: string; status: string }[] = [];
  for (const scenario of scenarios) {
    try {
      const steps = (await runScenario(target, scenario, side)).map(redact);
      const recording: Recording = {
        scenario: scenario.id,
        recordedAt: new Date().toISOString(),
        target: target.name,
        steps,
      };
      await writeFile(fixturePath(dir, scenario.id), `${JSON.stringify(recording, null, 2)}\n`);
      outcomes.push({
        scenario: scenario.id,
        status: steps.map((s) => s.response.status).join(','),
      });
    } catch (error) {
      outcomes.push({ scenario: scenario.id, status: `error: ${(error as Error).message}` });
    }
  }
  return outcomes;
};

export interface CompareOptions {
  playback?: boolean;
  side?: Side;
  divergences?: Divergence[];
}

export const effectiveMode = (scenario: Scenario, mode: Mode, playback: boolean): Mode =>
  mode === 'exact' && !playback && (scenario.needs ?? []).includes('llm') ? 'shape' : mode;

export const inOldNames = (response: Captured, side: Side): Captured =>
  side === 'old'
    ? response
    : {
        ...response,
        ...(response.body === undefined ? {} : { body: renamed(response.body, newToOld) }),
        ...(response.frames
          ? {
              frames: response.frames.map((f) =>
                f.kind === 'data' ? { ...f, data: renamed(f.data, newToOld) } : f,
              ),
            }
          : {}),
      };

const reason = (d: Divergence) => `ADR ${d.adr}: ${d.reason}`;

export const compare = async (
  target: Target,
  scenarios: Scenario[],
  dir: string,
  options: CompareOptions = {},
): Promise<ScenarioReport[]> => {
  const reports: ScenarioReport[] = [];
  const list = options.divergences ?? agreed;
  const side = options.side ?? 'new';
  for (const scenario of scenarios) {
    const base = {
      scenario: scenario.id,
      title: scenario.title,
      differences: [],
      ...(scenario.needs ? { needs: scenario.needs } : {}),
      ranAt: new Date().toISOString(),
    };
    const divergence = divergenceFor(scenario.id, list);
    if (divergence?.action === 'skip') {
      reports.push({ ...base, outcome: 'skipped', divergence: reason(divergence) });
      continue;
    }
    let recording: Recording;
    try {
      recording = JSON.parse(await readFile(fixturePath(dir, scenario.id), 'utf8')) as Recording;
    } catch {
      reports.push({ ...base, outcome: 'missing' });
      continue;
    }
    try {
      const fresh = await runScenario(target, scenario, side);
      const differences = scenario.steps.flatMap((step, i) => {
        const old = recording.steps[i];
        const next = fresh[i];
        if (!old || !next) {
          return [
            {
              step: step.name,
              severity: 'fail' as const,
              path: '$',
              old: String(!!old),
              new: String(!!next),
            },
          ];
        }
        return [
          ...compareCaptured(
            old.response,
            inOldNames(next.response, side),
            effectiveMode(scenario, step.mode, options.playback ?? false),
            scenario.comparedHeaders,
            parityScope,
          ),
          ...(step.check?.(next.response, fresh.slice(0, i)) ?? []).map((problem) => ({
            severity: 'fail' as const,
            path: '$.check',
            old: 'expected of the new platform',
            new: problem,
          })),
        ].map((d) => ({
          ...d,
          step: step.name,
        }));
      });
      const failed = differences.some((d) => d.severity === 'fail');
      if (!divergence) {
        reports.push({ ...base, differences, outcome: failed ? 'fail' : 'pass' });
        continue;
      }
      const last = fresh.at(-1)?.response;
      const problems = last ? meetsExpectation(last, divergence.expect) : ['no response'];
      if (!failed) problems.unshift('the new platform still behaves like headless-rag');
      reports.push({
        ...base,
        differences:
          problems.length > 0
            ? [
                ...differences,
                ...problems.map((p) => ({
                  step: 'divergence',
                  severity: 'fail' as const,
                  path: '$',
                  old: 'agreed divergence',
                  new: p,
                })),
              ]
            : differences,
        outcome: problems.length > 0 ? 'fail' : 'divergence',
        divergence: reason(divergence),
      });
    } catch (error) {
      reports.push({ ...base, outcome: 'error', error: (error as Error).message });
    }
  }
  return reports;
};

export const mergeReports = (
  previous: ScenarioReport[],
  fresh: ScenarioReport[],
  all: Scenario[],
  reason: string,
): ScenarioReport[] => {
  const ran = new Map(fresh.map((r) => [r.scenario, r]));
  const before = new Map(previous.map((r) => [r.scenario, r]));
  return all.map(
    (s) =>
      ran.get(s.id) ??
      before.get(s.id) ?? {
        scenario: s.id,
        title: s.title,
        outcome: 'not-run',
        differences: [],
        ...(s.needs ? { needs: s.needs } : {}),
        error: reason,
      },
  );
};
