import type { Event } from '@genai/contracts';
import { z } from 'zod';

const labels = z.record(z.string(), z.string());

const evaluationContext = z.object({
  run: z.object({ id: z.string().min(1), name: z.string().min(1), metadata: labels.optional() }),
  case: z.object({
    id: z.string().min(1),
    expected: z.unknown().optional(),
    metadata: labels.optional(),
  }),
});

/** A test case a task answers: its trace is one item of a Langfuse experiment, the run. */
export type Experiment = z.infer<typeof evaluationContext> & { rootTask: string };

/** The evaluation context a task's input carries when the task answers a case of a test run. */
export const evaluationIn = (event: Event) => {
  if (event.type !== 'kernel.task.input') return undefined;
  const parsed = evaluationContext.safeParse(
    (event.data as { evaluation?: unknown } | undefined)?.evaluation,
  );
  return parsed.success ? parsed.data : undefined;
};

const prefixed = (prefix: string, values: Record<string, string> | undefined) =>
  Object.fromEntries(
    Object.entries(values ?? {}).map(([key, value]) => [`${prefix}${key}`, value]),
  );

/** On every span of the item's trace, so Langfuse counts the trace as one item of the run. */
export const experimentAttributes = (experiment: Experiment, rootObservationId: string) => ({
  'langfuse.experiment.id': experiment.run.id,
  'langfuse.experiment.name': experiment.run.name,
  ...prefixed('langfuse.experiment.metadata.', experiment.run.metadata),
  'langfuse.experiment.item.id': experiment.case.id,
  'langfuse.experiment.item.root_observation_id': rootObservationId,
});

/** Only on the item's root span: the case's metadata, and what it expects when content is opted in. */
export const itemAttributes = (experiment: Experiment, content: boolean) => ({
  'langfuse.experiment.item.expected_output':
    content && experiment.case.expected !== undefined
      ? JSON.stringify(experiment.case.expected)
      : undefined,
  ...prefixed('langfuse.experiment.item.metadata.', experiment.case.metadata),
});
