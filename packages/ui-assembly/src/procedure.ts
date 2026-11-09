// «Fremgangsmåte» from genki's step frames, as genki's workspace builds it
// (apps/workspace/src/procedure.ts in #234), with its titles in the assembly's catalogue, lifted
// from the UI blocks preview. Only what genki sends: a step's label or its tool's title, in
// progress until the next one starts.
import type { Locale } from '@genai/i18n';
import type { ProcedureStep } from '@genai/ui-blocks';
import { translator, type AssemblyTranslator } from './i18n.js';

export type StepFrame = {
  event?: string;
  stage?: string;
  tool?: string;
  iteration?: number;
  label?: string;
} & Record<string, unknown>;

export interface Approach {
  frames: StepFrame[];
  startedAt: number;
  finishedAt?: number | undefined;
}

const toolTitles = {
  plan_queries: 'assembly.stepPlanQueries',
  inspect_filters: 'assembly.stepInspectFilters',
  search: 'assembly.stepSearch',
  read_chunks: 'assembly.stepReadChunks',
  rerank_results: 'assembly.stepRerankResults',
  report_gaps: 'assembly.stepReportGaps',
  generate_response: 'assembly.stepGenerateResponse',
} as const;

const isKnownTool = (tool: string): tool is keyof typeof toolTitles =>
  Object.hasOwn(toolTitles, tool);

const titleOf = (frame: StepFrame, t: AssemblyTranslator) =>
  (typeof frame.label === 'string' && frame.label.trim()) ||
  (frame.tool && isKnownTool(frame.tool) ? t(toolTitles[frame.tool]) : undefined);

/** The passages a finished turn says it read: the `chunk_ids` of its `read_chunks` calls. */
const passagesRead = (frame: StepFrame) => {
  const calls = frame['tool-calls'];
  if (!Array.isArray(calls)) return 0;
  return calls.reduce((total: number, call: unknown) => {
    const { tool, args } = (call ?? {}) as { tool?: unknown; args?: { chunk_ids?: unknown } };
    return tool === 'read_chunks' && Array.isArray(args?.chunk_ids)
      ? total + args.chunk_ids.length
      : total;
  }, 0);
};

/**
 * The steps so far. Each frame with a title starts a step and ends the one before. A run of the
 * same step one after another is one step with a count, «Leste de relevante delene nøye (4
 * ganger)», or, when genki says how many passages were read, «Leste 12 utdrag nøye». The same
 * step again after another one stays its own: searching again after reading is worth seeing.
 * Done here, not in Approach (#234), until its maintainer agrees to the same in the block.
 */
export const stepsOf = (
  approach: Approach,
  working: boolean,
  locale: Locale = 'nb',
): ProcedureStep[] => {
  const t = translator(locale);
  const runs: { id: string; title: string; tool?: string; count: number; passages: number }[] = [];
  for (const frame of approach.frames) {
    const read = passagesRead(frame);
    if (read > 0) {
      const reading = runs.findLast((run) => run.tool === 'read_chunks');
      if (reading) reading.passages += read;
    }
    const title = titleOf(frame, t);
    if (!title) continue;
    const last = runs.at(-1);
    if (last && last.title === title) {
      last.count += 1;
      continue;
    }
    const id = frame.tool ? `tool:${frame.tool}` : title;
    runs.push({
      id: runs.some((run) => run.id === id) ? `${id}:${runs.length}` : id,
      title,
      ...(frame.tool ? { tool: frame.tool } : {}),
      count: 1,
      passages: 0,
    });
  }
  return runs.map((run, at) => ({
    id: run.id,
    title:
      run.tool === 'read_chunks' && run.passages > 0
        ? t('assembly.stepPassages', { count: run.passages })
        : run.count > 1
          ? t('assembly.stepRepeated', { title: run.title, count: run.count })
          : run.title,
    status: working && at === runs.length - 1 ? 'active' : 'done',
  }));
};
