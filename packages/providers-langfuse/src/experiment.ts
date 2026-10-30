import type { ContentScope } from '@genai/kernel';
import type { EvaluationContext, Event } from '@genai/contracts';
import { z } from 'zod';
import type { TraceExporter } from './exporter.js';

const evaluationContext = z.object({
  run: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  case: z.object({
    id: z.string().min(1),
    repeat: z.number().int().nonnegative(),
    split: z.enum(['train', 'validation', 'holdout']),
  }),
  sink: z.string().min(1).optional(),
});

/** A case of an eval run: its task starts a trace of its own, one item of the run's experiment. */
export type Experiment = EvaluationContext & { rootTask: string };

/** The evaluation context recorded beside a task's input, when the task answers a case. */
export const evaluationIn = (event: Event): EvaluationContext | undefined => {
  if (event.type !== 'kernel.task.input') return undefined;
  const parsed = evaluationContext.safeParse(
    (event.data as { evaluation?: unknown } | undefined)?.evaluation,
  );
  return parsed.success ? parsed.data : undefined;
};

/** On every span of the item's trace, so Langfuse counts the trace as one item of the run. */
export const experimentAttributes = (experiment: Experiment, rootObservationId: string) => ({
  'langfuse.experiment.id': experiment.run.id,
  'langfuse.experiment.name': experiment.run.name,
  'langfuse.experiment.item.id': `${experiment.case.id}#${experiment.case.repeat}`,
  'langfuse.experiment.item.root_observation_id': rootObservationId,
});

/** Only on the item's root span. */
export const itemAttributes = (experiment: Experiment) => ({
  'langfuse.experiment.item.metadata.case': experiment.case.id,
  'langfuse.experiment.item.metadata.repeat': String(experiment.case.repeat),
  'langfuse.experiment.item.metadata.split': experiment.case.split,
});

export interface ExperimentRouter {
  /** Send the cases of a tenant's run to this exporter until the run is closed. */
  open(run: string, exporter: TraceExporter, tenant?: string): void;
  /** Flushes the run's sink and answers the case tasks whose traces went there. */
  close(run: string): Promise<string[]>;
  observe(event: Event, scope: ContentScope): void;
}

/**
 * Sends the tasks that answer an eval run's cases, and the tasks under them, to the exporter
 * opened for that run. Nothing else reaches it, so one tenant's run never reaches another's sink.
 */
export const createExperimentRouter = (): ExperimentRouter => {
  const exporters = new Map<string, TraceExporter>();
  const tenantOf = new Map<string, string>();
  const runOf = new Map<string, string>();
  const cases = new Map<string, Set<string>>();
  return {
    open: (run, exporter, tenant) => {
      exporters.set(run, exporter);
      if (tenant !== undefined) tenantOf.set(run, tenant);
    },
    close: async (run) => {
      const exporter = exporters.get(run);
      exporters.delete(run);
      tenantOf.delete(run);
      for (const [task, owner] of runOf) if (owner === run) runOf.delete(task);
      await exporter?.shutdown();
      const sent = [...(cases.get(run) ?? [])];
      cases.delete(run);
      return sent;
    },
    observe: (event, scope) => {
      const evaluation = evaluationIn(event);
      // A case reaches a run's sink only from the tenant the run was opened for.
      const owner = evaluation && tenantOf.get(evaluation.run.id);
      if (
        evaluation &&
        exporters.has(evaluation.run.id) &&
        (owner === undefined || owner === scope.tenant)
      ) {
        runOf.set(event.task, evaluation.run.id);
        cases.set(evaluation.run.id, (cases.get(evaluation.run.id) ?? new Set()).add(event.task));
      }
      const run = runOf.get(event.task);
      if (run === undefined) return;
      if (event.type === 'kernel.task.spawned') {
        const child = (event.data as { child?: unknown } | undefined)?.child;
        if (typeof child === 'string') runOf.set(child, run);
      }
      exporters.get(run)?.observe(event, scope);
    },
  };
};
