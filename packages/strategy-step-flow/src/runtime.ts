import { textPart, type Input, type Part } from '@genai/contracts';
import {
  flowSettingsWithDefaults,
  type FlowStep,
  type StepFlowDefinition,
} from '@genai/definitions';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import { languageInstructionsConfig } from '@genai/port-model';
import { z } from 'zod';
import { isPause, type BlockRegistry, type FlowRuntimeConfig } from './blocks.js';
import { StepFailure } from './blocks/model.js';
import { isTable, TABLE_MIME, tableCsv } from './blocks/table.js';
import {
  evaluateCondition,
  render,
  resolvePath,
  sameValue,
  type Scope,
  type StepRecord,
} from './expressions.js';
import type { FlowRetrievalFactory, FlowServices } from './services.js';

export const stepFlowConfig = z.strictObject({
  flow: z.string().regex(/^[a-z0-9][a-z0-9.-]*@\d+(\.\d+)*$/, 'must be a versioned flow reference'),
  vars: z.record(z.string(), z.unknown()).default({}),
  settings: z.record(z.string(), z.unknown()).optional(),
  result: z.string().min(1).optional(),
  maxSteps: z.number().int().positive().max(10_000).optional(),
  languageInstructions: languageInstructionsConfig.optional(),
});

export type StepFlowConfig = z.infer<typeof stepFlowConfig>;

export const stepFlowRuntimeConfig = z.looseObject({ strategy: stepFlowConfig });

export type FlowResolver = (
  ref: string,
  owner: string,
) => StepFlowDefinition | undefined | Promise<StepFlowDefinition | undefined>;

export interface StepFlowOptions {
  blocks: BlockRegistry;
  flows: FlowResolver;
  retrieval?: FlowRetrievalFactory;
  agent?: Strategy<unknown>;
  now?: () => Date;
  maxSteps?: number;
  maxDepth?: number;
}

interface Progress {
  version: 1;
  input: Input;
  done: Record<string, StepRecord>;
  pending?: string;
  executed: number;
}

const progressSchema = z.looseObject({
  version: z.literal(1),
  input: z.looseObject({}),
  done: z.record(z.string(), z.looseObject({ status: z.enum(['done', 'skipped', 'defaulted']) })),
  pending: z.string().optional(),
  executed: z.number().int().nonnegative(),
});

const failureCode = (error: unknown): string | undefined => {
  for (let e = error; e instanceof Error; e = e.cause) if (e instanceof StepFailure) return e.code;
  return undefined;
};

class Paused extends Error {}

class BudgetExceeded extends Error {}

const inputScope = (input: Input): Record<string, unknown> => {
  const data =
    typeof input.data === 'object' && input.data !== null && !Array.isArray(input.data)
      ? (input.data as Record<string, unknown>)
      : {};
  const text = (input.parts ?? [])
    .flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : []))
    .join('\n')
    .trim();
  const query = typeof data.query === 'string' && data.query.trim() ? data.query : text;
  return {
    ...data,
    query,
    text,
    history: Array.isArray(data.history) ? data.history : [],
    parts: input.parts ?? [],
  };
};

export const resultParts = (value: unknown): Part[] => {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [textPart(value)];
  if (isTable(value))
    return [
      { mime: TABLE_MIME, body: { kind: 'json', json: value } },
      { mime: 'text/csv', body: { kind: 'text', text: tableCsv(value) } },
    ];
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Array.isArray((value as { parts?: unknown }).parts)
  )
    return (value as { parts: Part[] }).parts;
  return [{ mime: 'application/json', body: { kind: 'json', json: value } }];
};

const matches = (when: unknown, value: unknown) =>
  Array.isArray(when) ? when.some((w) => sameValue(w, value)) : sameValue(when, value);

const actionOf = (step: FlowStep) =>
  step.block
    ? 'block'
    : step.repeat
      ? 'repeat'
      : step.forEach
        ? 'forEach'
        : step.switchOn
          ? 'switchOn'
          : 'subflow';

interface Frame {
  steps: Record<string, StepRecord>;
  input: Record<string, unknown>;
  vars: Record<string, unknown>;
  flows: string[];
}

class Runner {
  constructor(
    private readonly ctx: InvocationContext,
    private readonly config: FlowRuntimeConfig,
    private readonly strategy: StepFlowConfig,
    private readonly options: StepFlowOptions,
    private readonly services: FlowServices,
    private readonly progress: Progress,
    private readonly resumed: Input | undefined,
    private readonly settings: Record<string, unknown>,
  ) {}

  private get owner() {
    return this.config.model?.tenant ?? this.ctx.tenant;
  }

  private get maxSteps() {
    return this.strategy.maxSteps ?? this.options.maxSteps ?? 200;
  }

  private scope(frame: Frame): Scope {
    return {
      input: frame.input,
      config: this.config,
      settings: this.settings,
      vars: frame.vars,
      steps: frame.steps,
    };
  }

  private async save() {
    await this.ctx.state.checkpoint(this.progress);
  }

  async *runFlow(
    flow: StepFlowDefinition,
    frame: Frame,
    path: string,
  ): AsyncGenerator<Emitted, unknown> {
    return yield* this.runSteps(flow.spec.steps, frame, path);
  }

  private async *runSteps(
    steps: FlowStep[],
    frame: Frame,
    path: string,
  ): AsyncGenerator<Emitted, unknown> {
    let last: unknown;
    for (const step of steps) last = yield* this.runStep(step, frame, path);
    return last;
  }

  private async *runStep(
    step: FlowStep,
    frame: Frame,
    path: string,
  ): AsyncGenerator<Emitted, unknown> {
    if (this.ctx.signal.aborted) throw new Error('the flow was cancelled');
    const key = `${path}${step.id}`;
    const cached = this.progress.done[key];
    if (cached) {
      frame.steps[step.id] = cached;
      return cached.output;
    }
    const action = actionOf(step);
    const started = Date.now();
    yield this.notice(step, key, action, 'started');
    let record: StepRecord;
    if (step.block) record = yield* this.runBlock(step, frame, key);
    else if (step.repeat) record = yield* this.runRepeat(step, frame, key);
    else if (step.forEach) record = yield* this.runForEach(step, frame, key);
    else if (step.switchOn) record = yield* this.runSwitch(step, frame, key);
    else record = yield* this.runSubflow(step, frame, key);
    frame.steps[step.id] = record;
    this.progress.done[key] = record;
    await this.save();
    yield this.notice(step, key, action, record.status, Date.now() - started);
    return record.output;
  }

  private notice(
    step: FlowStep,
    key: string,
    action: string,
    status: string,
    ms?: number,
  ): Emitted {
    return {
      type: 'kernel.notice',
      data: {
        kind: 'step',
        step: step.id,
        path: key,
        action,
        ...(step.block ? { block: step.block } : {}),
        status,
        ...(ms === undefined ? {} : { ms }),
      },
    };
  }

  private async *runBlock(
    step: FlowStep,
    frame: Frame,
    key: string,
  ): AsyncGenerator<Emitted, StepRecord> {
    const ref = step.block as string;
    const block = this.options.blocks.get(ref);
    if (!block) throw new Error(`step ${step.id} uses unknown building block ${ref}`);
    try {
      this.progress.executed += 1;
      if (this.progress.executed > this.maxSteps)
        throw new BudgetExceeded(`the flow ran more than ${this.maxSteps} steps`);
      const scope = this.scope(frame);
      const input = block.input.parse(render(step.input ?? {}, scope));
      const params = block.params.parse(render(step.params ?? {}, scope));
      const resuming = this.progress.pending === key && this.resumed;
      const output: unknown = yield* block.run(
        {
          invocation: this.ctx,
          config: this.config,
          services: this.services,
          step: step.id,
          input: frame.input,
          ...(resuming
            ? { resumed: { response: this.resumed?.data, parts: this.resumed?.parts ?? [] } }
            : {}),
        },
        input,
        params,
      );
      if (resuming) delete this.progress.pending;
      if (isPause(output)) {
        this.progress.pending = key;
        this.progress.executed -= 1;
        await this.save();
        yield {
          type: 'kernel.interrupt',
          data: {
            id: output.pause.id ?? `step:${key}`,
            reason: output.pause.reason,
            prompt: output.pause.prompt,
          },
        };
        throw new Paused();
      }
      const checked = block.output.safeParse(output);
      if (!checked.success)
        throw new Error(`block ${ref} returned an output that does not match its contract`);
      return { status: 'done', output };
    } catch (error) {
      if (error instanceof Paused || error instanceof BudgetExceeded || this.ctx.signal.aborted)
        throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (step.onError === 'skip') {
        yield {
          type: 'kernel.notice',
          data: { kind: 'step', step: step.id, path: key, status: 'failed', error: message },
        };
        return { status: 'skipped', output: null };
      }
      if (step.onError === 'use-default') {
        yield {
          type: 'kernel.notice',
          data: { kind: 'step', step: step.id, path: key, status: 'failed', error: message },
        };
        return { status: 'defaulted', output: step.default };
      }
      throw new Error(`step ${step.id} failed: ${message}`, { cause: error });
    }
  }

  private async *runRepeat(
    step: FlowStep,
    frame: Frame,
    key: string,
  ): AsyncGenerator<Emitted, StepRecord> {
    const repeat = step.repeat as NonNullable<FlowStep['repeat']>;
    const iterations: unknown[] = [];
    let met = false;
    for (let i = 0; i < repeat.max && !met; i += 1) {
      const vars = { ...frame.vars, loop: { index: i, previous: iterations.at(-1) ?? null } };
      const inner: Frame = { ...frame, vars };
      iterations.push(yield* this.runSteps(repeat.steps, inner, `${key}#${i}/`));
      met = evaluateCondition(repeat.until, this.scope(inner));
    }
    return {
      status: 'done',
      output: { iterations, last: iterations.at(-1) ?? null, exhausted: !met },
    };
  }

  private async *runForEach(
    step: FlowStep,
    frame: Frame,
    key: string,
  ): AsyncGenerator<Emitted, StepRecord> {
    const each = step.forEach as NonNullable<FlowStep['forEach']>;
    const items = resolvePath(each.in, this.scope(frame));
    if (!Array.isArray(items)) throw new Error(`step ${step.id}: ${each.in} is not a list`);
    const outputs: unknown[] = [];
    for (const [i, item] of items.entries()) {
      const vars = { ...frame.vars, [each.as]: item, loop: { index: i } };
      try {
        outputs.push(yield* this.runSteps(each.steps, { ...frame, vars }, `${key}#${i}/`));
      } catch (error) {
        if (
          !step.onError ||
          step.onError === 'stop' ||
          error instanceof Paused ||
          error instanceof BudgetExceeded ||
          this.ctx.signal.aborted
        )
          throw error;
        const message = error instanceof Error ? error.message : String(error);
        yield {
          type: 'kernel.notice',
          data: {
            kind: 'step',
            step: step.id,
            path: `${key}#${i}`,
            item: i,
            status: 'failed',
            error: message,
            ...(failureCode(error) ? { code: failureCode(error) } : {}),
          },
        };
        const code = failureCode(error);
        outputs.push(
          step.onError === 'skip'
            ? { skipped: true, error: message, ...(code ? { code } : {}) }
            : step.default,
        );
      }
    }
    return { status: 'done', output: outputs };
  }

  private async *runSwitch(
    step: FlowStep,
    frame: Frame,
    key: string,
  ): AsyncGenerator<Emitted, StepRecord> {
    const value = resolvePath(step.switchOn as string, this.scope(frame));
    const index = (step.cases ?? []).findIndex((c) => matches(c.when, value));
    const branch = index >= 0 ? step.cases?.[index]?.steps : step.else;
    if (!branch) return { status: 'skipped', output: null };
    const label = index >= 0 ? `case${index}` : 'else';
    return { status: 'done', output: yield* this.runSteps(branch, frame, `${key}:${label}/`) };
  }

  private async *runSubflow(
    step: FlowStep,
    frame: Frame,
    key: string,
  ): AsyncGenerator<Emitted, StepRecord> {
    const ref = step.subflow as string;
    if (frame.flows.includes(ref)) throw new Error(`step ${step.id}: flow ${ref} calls itself`);
    if (frame.flows.length >= (this.options.maxDepth ?? 8))
      throw new Error(`step ${step.id}: subflows are nested too deep`);
    const flow = await this.options.flows(ref, this.owner);
    if (!flow) throw new Error(`step ${step.id}: no step flow ${ref}`);
    const input = step.input
      ? (render(step.input, this.scope(frame)) as Record<string, unknown>)
      : frame.input;
    const child: Frame = {
      steps: {},
      input: { ...frame.input, ...input },
      vars: frame.vars,
      flows: [...frame.flows, ref],
    };
    return { status: 'done', output: yield* this.runFlow(flow, child, `${key}>`) };
  }
}

export const createStepFlow = (options: StepFlowOptions): Strategy<unknown> => {
  const services: FlowServices = {
    now: options.now ?? (() => new Date()),
    ...(options.retrieval ? { retrieval: options.retrieval } : {}),
    ...(options.agent ? { agent: options.agent } : {}),
  };

  async function* execute(
    ctx: InvocationContext,
    input: Input,
    raw: unknown,
    progress: Progress,
    resumed: Input | undefined,
  ): AsyncGenerator<Emitted> {
    const config = stepFlowRuntimeConfig.parse(raw) as FlowRuntimeConfig & {
      strategy: StepFlowConfig;
    };
    const strategy = config.strategy;
    const flow = await options.flows(strategy.flow, config.model?.tenant ?? ctx.tenant);
    if (!flow) throw new Error(`no step flow ${strategy.flow}`);
    const settings = flowSettingsWithDefaults(flow.spec.settings, strategy.settings);
    const runner = new Runner(
      ctx,
      config,
      strategy,
      options,
      services,
      progress,
      resumed,
      settings,
    );
    const frame: Frame = {
      steps: {},
      input: inputScope(input),
      vars: { ...strategy.vars },
      flows: [strategy.flow],
    };
    try {
      const last = yield* runner.runFlow(flow, frame, '');
      const value = strategy.result
        ? resolvePath(strategy.result, {
            input: frame.input,
            config,
            settings,
            vars: frame.vars,
            steps: frame.steps,
          })
        : last;
      yield { type: 'kernel.result', data: resultParts(value) };
    } catch (error) {
      if (error instanceof Paused) return;
      throw error;
    }
  }

  return {
    id: 'step-flow',
    version: '1',
    requires: { kernel: 1, ports: ['model', 'tools'], features: ['checkpoint', 'interrupts'] },
    run: (ctx, input, raw) =>
      execute(ctx, input, raw, { version: 1, input, done: {}, executed: 0 }, undefined),
    resume: (ctx, checkpoint, response, raw) => {
      const progress = progressSchema.parse(checkpoint) as unknown as Progress;
      return execute(ctx, progress.input, raw, progress, response);
    },
  };
};
