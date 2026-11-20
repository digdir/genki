/**
 * Renames the Kudos draft's sources to the `kudos:` ids a copy into the knowledge database gives,
 * each with the page a knowledge fill puts its old chunk on (issue 394). Read-only until `--write`:
 * it reads the old chunks from today's Kudos index in Typesense and the pages from a Docling export.
 *
 *   tsx --conditions=source packages/eval/src/scripts/kudos-ids.ts <docling dir> [--write]
 *
 * `<docling dir>` holds `<first two hex>/<sha256>/docling.json` for each PDF. Each old chunk is read
 * as a copy reads it (`copiedDocument`), so its Marker page is the copy's, and gets the Docling page
 * (`doclingPages`, the pages a fill stores) that holds most of its words (`kudosPage`). The sources
 * it lists are printed and kept in the set's provenance.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { kudosEarlierIdsMap } from '@genai/contracts';
import { copiedDocument, doclingPages, kudosEarlierIds, readDoclingOutput } from '@genai/ingest';
import { envSecrets, type PortContext } from '@genai/kernel';
import { KnowledgeRouter } from '@genai/port-knowledge';
import { typesense } from '@genai/providers-typesense';
import { testSetYaml } from '../drafting.js';
import { kudosPage, renameKudosSources, type KudosPage } from '../mapping.js';
import { parseTestSetYaml } from '../schema.js';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const envFile = join(root, '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const baseURL = process.env.TYPESENSE_URL;
if (!baseURL) throw new Error('TYPESENSE_URL is not set in .env.local');

const [doclingDir, flag] = process.argv.slice(2);
if (!doclingDir || !existsSync(doclingDir))
  throw new Error('usage: kudos-ids <docling dir> [--write]');

const example = parseYaml(
  readFileSync(join(root, 'packages', 'providers-typesense', 'examples', 'kudos.yaml'), 'utf8'),
) as { endpoints: Record<string, Record<string, unknown>>; datasets: Record<string, unknown>[] };

const router = new KnowledgeRouter({
  catalog: {
    endpoints: { 'kudos-typesense': { ...example.endpoints['kudos-typesense'], baseURL } },
    datasets: [{ ...example.datasets[0], id: 'probe/kudos' }],
  },
  adapters: [typesense],
  secrets: envSecrets(),
});

const context: PortContext = {
  tenant: '991825827',
  principal: { kind: 'operator', issuer: 'local', subject: 'eval-script' },
  task: 'eval-script',
  signal: new AbortController().signal,
  meter: async () => undefined,
};

const exported = router.open({ kind: 'dataset', id: 'probe/kudos' }, context).export;
if (!exported?.document) throw new Error('the Kudos index cannot hand over its documents');
const readDocument = exported.document.bind(exported);

const file = join(import.meta.dirname, '..', '..', 'testsets', 'ka-kudos-draft.yaml');
const set = parseTestSetYaml(readFileSync(file, 'utf8'));
const earlierIds = kudosEarlierIds();
const kudosIdOf = new Map([...earlierIds].flatMap(([id, numbers]) => numbers.map((n) => [n, id])));

/** Each file's Docling pages, page n at index n - 1, for the files the export has. */
const doclingOf = (fields: Record<string, unknown>) =>
  (Array.isArray(fields.files) ? (fields.files as { sha256?: unknown }[]) : []).flatMap((f) => {
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return [];
    const path = join(doclingDir, f.sha256.slice(0, 2), f.sha256, 'docling.json');
    return existsSync(path) ? [doclingPages(readDoclingOutput(readFileSync(path)))] : [];
  });

const wanted = new Map<string, Set<number>>();
for (const s of set.spec.cases.flatMap((c) => c.expected.sources))
  if (s.document !== undefined && s.position !== undefined)
    wanted.set(s.document, (wanted.get(s.document) ?? new Set()).add(s.position));

const pages = new Map<string, KudosPage>();
for (const [n, positions] of wanted) {
  const id = kudosIdOf.get(n);
  const old = id === undefined ? undefined : await readDocument(n);
  if (id === undefined || !old) continue;
  const docling = doclingOf(old.fields);
  for (const chunk of copiedDocument(id, old).chunks.filter((c) => positions.has(c.position))) {
    const marker = chunk.metadata?.page;
    pages.set(
      `${n}/${chunk.position}`,
      kudosPage(chunk.text, docling, typeof marker === 'number' ? marker : undefined),
    );
  }
}

const today = new Date().toISOString().slice(0, 10);
const result = renameKudosSources(set, {
  earlierIds,
  unresolved: kudosEarlierIdsMap.unresolved,
  pageOf: (s) => pages.get(`${s.document}/${s.position}`),
  map: 'packages/contracts/src/kudos-earlier-ids.json',
  pages:
    "from the Docling export (docling-pages 1), the page holding most of each old chunk's words, Marker's page where none holds half",
  mappedOn: today,
});

console.log(JSON.stringify({ renamed: result.renamed, listed: result.listed.length }));
for (const l of result.listed) console.log(JSON.stringify(l));
if (flag === '--write') writeFileSync(file, testSetYaml(result.set));
