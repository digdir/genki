import { knowledgeDropQueue, queueWork } from '@genai/jobs';
import type { DatasetConfig } from '@genai/port-knowledge';

export const wholeDatasetDropMessage = 'dropping a whole dataset comes with issue 250';

export interface DropDeps {
  /** The catalog's datasets on the knowledge database, each with its active generation. */
  datasets(): DatasetConfig[];
  /** The knowledge server, as its owner: which dataset a generation belongs to, and its drop. */
  server: {
    datasetOf(generation: string): Promise<string | undefined>;
    drop(generation: string): Promise<void>;
  };
  /** Throws while the knowledge server is bound to another platform server (ADR 0042). */
  bound?: () => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * `knowledge.drop`, sent by the API's sweep for a generation an engine switch left behind (ADR
 * 0025): detaches and drops it with its records' applied changes, never one the catalog reads, nor
 * one of another dataset. A generation already gone has nothing left to drop.
 */
export const dropWork = (deps: DropDeps) =>
  queueWork(knowledgeDropQueue, async (job) => {
    deps.bound?.();
    if (!('generation' in job.data)) throw new Error(wholeDatasetDropMessage);
    const { dataset, generation } = job.data;
    const reading = deps.datasets().find((d) => d.generation === generation);
    if (reading)
      throw new Error(
        `the generation ${generation} is the active generation of ${reading.id}, so it is not dropped`,
      );
    const owner = await deps.server.datasetOf(generation);
    if (owner === undefined) return;
    if (owner !== dataset)
      throw new Error(`the generation ${generation} belongs to ${owner}, not to ${dataset}`);
    await deps.server.drop(generation);
    deps.log?.('knowledge generation dropped', { dataset, generation });
  });
