import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { platformScope } from './config-store.js';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { pipelineSpec, type IngestionService } from './ingestion.js';

export const pipelineSeedActor = 'platform:seed';

const pipelineSeed = z.strictObject({
  dataset: z.string().min(1),
  id: z.string().min(1),
  spec: pipelineSpec,
});

export type PipelineSeed = z.infer<typeof pipelineSeed>;

export const readPipelineSeeds = (
  dir: string,
): { seeds: PipelineSeed[]; unreadable: { file: string; error: string }[] } => {
  const seeds: PipelineSeed[] = [];
  const unreadable: { file: string; error: string }[] = [];
  if (!existsSync(dir)) return { seeds, unreadable };
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    const parsed = pipelineSeed.safeParse(parseYaml(readFileSync(join(dir, file), 'utf8')));
    if (parsed.success) seeds.push(parsed.data);
    else unreadable.push({ file, error: parsed.error.message });
  }
  return { seeds, unreadable };
};

export type PipelineSeedOutcome = {
  dataset: string;
  id: string;
  state: 'created' | 'updated' | 'present' | 'kept' | 'failed';
  errors?: { path: string; message: string }[];
};

type Pipelines = Pick<IngestionService, 'get' | 'save'>;

export const seedPipelines = async (
  ingestion: Pipelines,
  seeds: PipelineSeed[],
  reason = 'local configuration',
): Promise<PipelineSeedOutcome[]> => {
  const outcomes: PipelineSeedOutcome[] = [];
  for (const seed of seeds) {
    const current = await ingestion.get(platformScope, seed.dataset, seed.id);
    if (current && isDeepStrictEqual(current.spec, seed.spec)) {
      outcomes.push({ dataset: seed.dataset, id: seed.id, state: 'present' });
      continue;
    }
    if (current && current.by !== pipelineSeedActor) {
      outcomes.push({ dataset: seed.dataset, id: seed.id, state: 'kept' });
      continue;
    }
    const saved = await ingestion.save({
      scope: platformScope,
      dataset: seed.dataset,
      id: seed.id,
      spec: seed.spec,
      by: pipelineSeedActor,
      reason,
      ...(current ? { ifVersion: current.version } : {}),
    });
    outcomes.push(
      saved.ok
        ? { dataset: seed.dataset, id: seed.id, state: current ? 'updated' : 'created' }
        : { dataset: seed.dataset, id: seed.id, state: 'failed', errors: saved.errors },
    );
  }
  return outcomes;
};
