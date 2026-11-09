// «Fremgangsmåte» from genki's step frames, as genki's workspace builds it
// (apps/workspace/src/procedure.ts in #234), with its Norwegian titles, lifted from the UI blocks
// preview. Only what genki sends: a step's label or its tool's title, in progress until the next
// one starts.
import type { ProcedureStep } from '@genai/ui-blocks';

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

const toolTitles: Record<string, string> = {
  plan_queries: 'Forsto spørsmålet',
  inspect_filters: 'Så på hvilke kilder tråden leser fra',
  search: 'Lette etter steder som handler om spørsmålet',
  read_chunks: 'Leste de relevante delene nøye',
  rerank_results: 'Valgte ut det som svarer på spørsmålet',
  report_gaps: 'Det jeg ikke fant',
  generate_response: 'Skrev svaret',
};

const titleOf = (frame: StepFrame) =>
  (typeof frame.label === 'string' && frame.label.trim()) ||
  (frame.tool ? toolTitles[frame.tool] : undefined);

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
export const stepsOf = (approach: Approach, working: boolean): ProcedureStep[] => {
  const runs: { id: string; title: string; tool?: string; count: number; passages: number }[] = [];
  for (const frame of approach.frames) {
    const read = passagesRead(frame);
    if (read > 0) {
      const reading = runs.findLast((run) => run.tool === 'read_chunks');
      if (reading) reading.passages += read;
    }
    const title = titleOf(frame);
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
        ? `Leste ${run.passages} utdrag nøye`
        : run.count > 1
          ? `${run.title} (${run.count} ganger)`
          : run.title,
    status: working && at === runs.length - 1 ? 'active' : 'done',
  }));
};
