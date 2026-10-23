import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { recordsUrl } from './ai-policy-jurisdictions.ts';

const local = join(import.meta.dirname, '../apps/api/config/local');
const revision = '767146c7cc29773d4eab468cf159009a8b7676f7';
const release = 'data version 1.18 (2026-10-19)';
const read = (path: string) => readFileSync(join(local, path), 'utf8');

describe('the AI policy release', () => {
  it('pins records and definitions to the same immutable release and disables scheduled refresh', () => {
    for (const name of ['records', 'definitions']) {
      const pipeline = parseYaml(read(`pipelines/ai-policy-${name}.yaml`));

      expect(pipeline.spec.source.huggingface).toEqual({
        dataset: 'kelkalot/every-ai-policy-ever',
        file: `data/${name}.parquet`,
        revision,
      });
      expect(pipeline.spec.schedule).toBe('none');
    }
  });

  it('uses the release version and date consistently in the dated instructions and eval grounding', () => {
    const files = ['flows', 'prompts', 'services', 'skills'].flatMap((dir) =>
      readdirSync(join(local, dir))
        .filter((file) => file.startsWith('ai-policy-'))
        .map((file) => join(dir, file)),
    );
    for (const file of files) expect(read(file), file).not.toContain('2026-10-18');
    for (const file of [
      'flows/ai-policy-brief.yaml',
      'flows/ai-policy-comparison.yaml',
      'prompts/ai-policy-guide.nb.md',
      'services/ai-policy-guide.yaml',
      'skills/ai-policy-binding-check.yaml',
      'skills/ai-policy-timeline.yaml',
    ])
      expect(read(file), file).toContain(release);

    const testset = readFileSync(
      join(import.meta.dirname, '../packages/eval/testsets/ai-policy-guide-draft.yaml'),
      'utf8',
    );
    expect(testset).not.toContain('2026-10-18');
    expect(parseYaml(testset).spec.provenance.draftedBy).toContain(release);
  });

  it('regenerates jurisdiction names from the pinned records rather than a moving branch', () => {
    expect(recordsUrl).toBe(
      `https://huggingface.co/datasets/kelkalot/every-ai-policy-ever/resolve/${revision}/data/records.parquet`,
    );
  });
});
