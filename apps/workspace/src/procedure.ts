import type { ProcedureStep } from '@genai/ui-blocks';
import type { PlainKey, T } from './i18n';

/** A `genai_step` frame. Members not in docs/frontend-contract.md come only from the example data. */
export interface StreamStep {
  event?: string;
  stage?: string;
  label?: string;
  tool?: string;
  iteration?: number;
  /** The steps the run will take, by tool name, so the ones not reached yet show as waiting. */
  plan?: string[];
  description?: string;
  documents?: { title: string; pages?: string }[];
  'documents-read'?: number;
  /** Documents the run reads from in all, for the line at the bottom. */
  'documents-total'?: number;
  'sources-used'?: number[];
  missing?: boolean;
}

/** A step as the workspace keeps it; `key` names the tool or label it came from. */
export interface StreamedStep extends ProcedureStep {
  key: string;
}

export interface ProcedureState {
  steps: readonly StreamedStep[];
  read?: number;
}

const toolTitles: Readonly<Record<string, PlainKey>> = {
  plan_queries: 'procedure.plan_queries',
  inspect_filters: 'procedure.inspect_filters',
  search: 'procedure.search',
  read_chunks: 'procedure.read_chunks',
  rerank_results: 'procedure.rerank_results',
  report_gaps: 'procedure.report_gaps',
  generate_response: 'procedure.generate_response',
};

const toolTitle = (tool: string | undefined, t: T) => {
  const key = tool && Object.hasOwn(toolTitles, tool) ? toolTitles[tool] : undefined;
  return key ? t(key) : undefined;
};

const titleOf = (frame: StreamStep, t: T) =>
  (typeof frame.label === 'string' && frame.label.trim()) || toolTitle(frame.tool, t);

const keyOf = (frame: StreamStep, title: string) => (frame.tool ? `tool:${frame.tool}` : title);

const detailsOf = (frame: StreamStep): Partial<ProcedureStep> => ({
  ...(frame.description ? { description: frame.description } : {}),
  ...(frame.documents?.length
    ? {
        documents: frame.documents.map((d) => ({
          title: d.title,
          ...(d.pages ? { detail: d.pages } : {}),
        })),
      }
    : {}),
  ...(frame['documents-read'] !== undefined ? { documentsRead: frame['documents-read'] } : {}),
  ...(frame['sources-used']?.length ? { sourcesUsed: frame['sources-used'] } : {}),
  ...(frame.missing ? { missing: true } : {}),
});

const planned = (steps: readonly StreamedStep[], plan: string[] | undefined, t: T) => {
  if (!plan?.length) return steps;
  const waiting = plan.flatMap((tool) => {
    const title = toolTitle(tool, t);
    const key = `tool:${tool}`;
    return title && !steps.some((s) => s.key === key)
      ? [{ id: key, key, title, status: 'waiting' as const }]
      : [];
  });
  return waiting.length ? [...steps, ...waiting] : steps;
};

/** The approach after one more frame: the step it names is in progress, the ones before it done. */
export const withStep = (state: ProcedureState, frame: StreamStep, t: T): ProcedureState => {
  const read = frame['documents-total'];
  const withRead = read !== undefined && read !== state.read ? { ...state, read } : state;
  const steps = planned(withRead.steps, frame.plan, t);
  const title = titleOf(frame, t);
  if (!title) return steps === withRead.steps ? withRead : { ...withRead, steps };
  const key = keyOf(frame, title);
  const details = detailsOf(frame);
  const at = steps.findIndex((s) => s.key === key && s.status !== 'done');
  const current = steps[at];
  if (current?.status === 'active' && !Object.keys(details).length)
    return steps === withRead.steps ? withRead : { ...withRead, steps };
  const added: StreamedStep = {
    id: steps.some((s) => s.key === key) ? `${key}:${steps.length}` : key,
    key,
    title,
    status: 'active',
    ...details,
  };
  const done = (s: StreamedStep): StreamedStep =>
    s.status === 'active' ? { ...s, status: 'done' } : s;
  const next: StreamedStep[] =
    at === -1
      ? [
          ...steps.filter((s) => s.status !== 'waiting').map(done),
          added,
          ...steps.filter((s) => s.status === 'waiting'),
        ]
      : steps.map((s, i): StreamedStep =>
          i === at
            ? { ...s, title, ...details, status: 'active' }
            : i < at
              ? { ...s, status: 'done' }
              : s,
        );
  return { ...withRead, steps: next };
};

/** The steps when the answer is done: all done, without planned steps the run never reached. */
export const allDone = <S extends ProcedureStep>(steps: readonly S[]): readonly S[] =>
  steps.flatMap((s) =>
    s.status === 'waiting' ? [] : s.status === 'done' ? [s] : [{ ...s, status: 'done' as const }],
  );
