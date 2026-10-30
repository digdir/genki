import type { Part, Principal } from '@genai/contracts';
import type { Emitted, Kernel, Strategy } from '@genai/kernel';
import { z } from 'zod';
import { EvalError, type Evaluator } from './evaluators.js';
import {
  describeTask,
  runEval,
  type EvalTarget,
  type RunEvalOptions,
  type WaitOptions,
} from './runner.js';
import { splits, testSet } from './schema.js';

export const evalRunConfig = z.strictObject({
  id: z.string().min(1).optional(),
  capability: z.string().min(1),
  testSet,
  evaluators: z.array(z.string()).min(1),
  repeats: z.number().int().positive().max(20).default(1),
  splits: z.array(z.enum(splits)).min(1).default(['train', 'validation']),
  provenance: z.strictObject({ commit: z.string().min(1), data: z.string().min(1) }),
  /** Send each case's trace to this sink, as one experiment; holdout cases never go. */
  sink: z.string().min(1).optional(),
  /** Models the run's judges must not share a family with: the tested service's own models. */
  avoidAsJudge: z.array(z.string()).optional(),
  /** The sink's judges as they were when the run started, for forRun to score with. */
  sinkJudges: z.array(z.unknown()).optional(),
});
export type EvalRunConfig = z.input<typeof evalRunConfig>;

export interface EvalStrategyDeps {
  kernel: () => Kernel;
  evaluators: Map<string, Evaluator>;
  modelFamily?: (model: string) => string | undefined;
  admit?: (tenant: string) => Promise<boolean>;
  wait?: WaitOptions;
  meterAnswers?: RunEvalOptions['meterAnswers'];
  /** Evaluators made for one run, such as a judge whose model is picked for the run's tenant. */
  forRun?: (
    principal: Principal,
    run: {
      avoid: string[];
      id?: string;
      evaluators: string[];
      sink?: string;
      sinkJudges?: unknown[];
    },
  ) => Map<string, Evaluator> | Promise<Map<string, Evaluator>>;
}

export interface EvalNotice {
  kind: 'eval.progress' | 'eval.waiting';
  [key: string]: unknown;
}

export const evalRunStrategy = (deps: EvalStrategyDeps): Strategy<Partial<EvalRunConfig>> => ({
  id: 'platform.eval.run',
  version: '1',
  requires: { kernel: 1, ports: [], features: ['subinvoke'] },
  run: async function* (ctx, input, config): AsyncIterable<Emitted> {
    const parsed = evalRunConfig.safeParse({ ...config, ...(input.data as object | undefined) });
    if (!parsed.success)
      throw new EvalError(
        `invalid eval run: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    const options = parsed.data;
    const ownEvaluators =
      (await deps.forRun?.(ctx.principal, {
        avoid: options.avoidAsJudge ?? [],
        ...(options.id ? { id: options.id } : {}),
        evaluators: options.evaluators,
        ...(options.sink ? { sink: options.sink } : {}),
        ...(options.sinkJudges ? { sinkJudges: options.sinkJudges } : {}),
      })) ?? new Map<string, Evaluator>();
    const evaluators = options.evaluators.map((id) => {
      const evaluator = ownEvaluators.get(id) ?? deps.evaluators.get(id);
      if (!evaluator) throw new EvalError(`unknown evaluator ${id}`);
      return evaluator;
    });
    const kernel = deps.kernel();
    const target: EvalTarget = {
      capability: options.capability,
      invoke: async (caseInput, item) => {
        const tenant = ctx.principal.tenant;
        if (tenant && deps.admit && !(await deps.admit(tenant)))
          throw new EvalError('the monthly token quota is used up');
        const run = await ctx.invoke(
          options.capability,
          caseInput,
          options.sink && options.id && item && item.case.split !== 'holdout'
            ? {
                evaluation: {
                  run: {
                    id: options.id,
                    name: `${options.testSet.metadata.id} v${options.testSet.metadata.version}`,
                  },
                  case: {
                    id: item.case.id,
                    repeat: item.repeat,
                    split: item.case.split,
                    ...(item.case.expected.criteria
                      ? { expected: item.case.expected.criteria }
                      : {}),
                  },
                  sink: options.sink,
                },
              }
            : {},
        );
        return describeTask(kernel, ctx.principal, run.task, await run.result);
      },
      annotate: (task, score) =>
        kernel.annotate(ctx.principal, task, { type: 'kernel.score', data: score }),
    };

    const notices: EvalNotice[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const notify = (notice: EvalNotice) => {
      notices.push(notice);
      wake?.();
    };
    const running = runEval({
      ...(options.id ? { id: options.id } : {}),
      target,
      testSet: options.testSet,
      evaluators,
      provenance: options.provenance,
      repeats: options.repeats,
      splits: options.splits,
      ...(deps.modelFamily ? { modelFamily: deps.modelFamily } : {}),
      ...(deps.wait ? { wait: deps.wait } : {}),
      ...(deps.meterAnswers ? { meterAnswers: deps.meterAnswers } : {}),
      signal: ctx.signal,
      onProgress: (done, total, usage) =>
        notify({ kind: 'eval.progress', done, total, ...(usage ? { usage } : {}) }),
      onWaiting: (pending, until) => notify({ kind: 'eval.waiting', pending, until }),
    }).finally(() => {
      finished = true;
      wake?.();
    });
    running.catch(() => undefined);

    while (!finished || notices.length > 0) {
      const next = notices.shift();
      if (next) {
        yield { type: 'kernel.notice', data: next };
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    const run = await running;
    const part: Part = { mime: 'application/json', body: { kind: 'json', json: run } };
    yield { type: 'kernel.result', data: [part] };
  },
});
