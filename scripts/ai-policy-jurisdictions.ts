import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { parse as parseYaml } from 'yaml';

// The comparison flow filters each jurisdiction by its exact name, so its extract step picks
// names from an enum copied from the pinned register. Rerun this when its revision changes:
//   node scripts/ai-policy-jurisdictions.ts            rewrites the enum
//   node scripts/ai-policy-jurisdictions.ts --check    exits 1 when the enum differs from the register

export const repoRoot = join(import.meta.dirname, '..');
export const flowPath = join(repoRoot, 'apps/api/config/local/flows/ai-policy-comparison.yaml');
const recordsPipeline = parseYaml(
  readFileSync(join(repoRoot, 'apps/api/config/local/pipelines/ai-policy-records.yaml'), 'utf8'),
) as { spec: { source: { huggingface: { dataset: string; file: string; revision: string } } } };
const source = recordsPipeline.spec.source.huggingface;
export const recordsUrl = `https://huggingface.co/datasets/${source.dataset}/resolve/${source.revision}/${source.file}`;

export const jurisdictionsOf = (rows: { jurisdiction?: unknown }[]) =>
  [
    ...new Set(
      rows.flatMap((r) =>
        typeof r.jurisdiction === 'string' && r.jurisdiction.trim() ? [r.jurisdiction.trim()] : [],
      ),
    ),
  ].sort();

const enumBlock = /^( *)enum:\n *\[\n[\s\S]*?\n *\]\n/m;

export const enumOf = (flow: string): string[] => {
  const parsed = parseYaml(flow) as {
    spec: { steps: { params?: { schema?: { properties?: Record<string, unknown> } } }[] };
  };
  const list = parsed.spec.steps[0]?.params?.schema?.properties?.jurisdictions as
    { items?: { enum?: string[] } } | undefined;
  return list?.items?.enum ?? [];
};

export const withEnum = (flow: string, names: string[]) => {
  const found = enumBlock.exec(flow);
  if (!found) throw new Error('the flow has no jurisdiction enum');
  const indent = found[1] ?? '';
  const quoted = names.map((n) => `${indent}    '${n.replace(/'/g, "''")}',`);
  return flow.replace(
    enumBlock,
    `${indent}enum:\n${indent}  [\n${quoted.join('\n')}\n${indent}  ]\n`,
  );
};

export const drift = (current: string[], wanted: string[]) => ({
  added: wanted.filter((n) => !current.includes(n)),
  removed: current.filter((n) => !wanted.includes(n)),
});

export const readJurisdictions = async (source: string) => {
  const bytes = /^https?:\/\//.test(source)
    ? await (await fetch(source)).arrayBuffer()
    : new Uint8Array(readFileSync(source)).buffer;
  const rows = await parquetReadObjects({ file: bytes, columns: ['jurisdiction'], compressors });
  return jurisdictionsOf(rows as { jurisdiction?: unknown }[]);
};

const main = async () => {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const source = args.find((a) => !a.startsWith('--')) ?? recordsUrl;
  const wanted = await readJurisdictions(source);
  const flow = readFileSync(flowPath, 'utf8');
  const { added, removed } = drift(enumOf(flow), wanted);
  if (added.length === 0 && removed.length === 0) {
    console.log(`The enum matches the register: ${wanted.length} jurisdictions.`);
    return;
  }
  console.log(`Added: ${added.join(', ') || 'none'}. Removed: ${removed.join(', ') || 'none'}.`);
  if (check) process.exit(1);
  writeFileSync(flowPath, withEnum(flow, wanted));
  console.log(`Rewrote ${flowPath} with ${wanted.length} jurisdictions.`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
