import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { envSecrets, type PortContext } from '@genai/kernel';
import { KnowledgeRouter, type KnowledgePort } from '@genai/port-knowledge';
import { typesense } from '@genai/providers-typesense';
import { sampleCandidates, testSetYaml } from '../drafting.js';
import { mapSources, unreachable } from '../mapping.js';
import type { TestSet } from '../schema.js';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const envFile = join(root, '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const baseURL = process.env.TYPESENSE_URL;
if (!baseURL) throw new Error('TYPESENSE_URL is not set in .env.local');

const example = parseYaml(
  readFileSync(join(root, 'packages', 'providers-typesense', 'examples', 'kudos.yaml'), 'utf8'),
) as { endpoints: Record<string, Record<string, unknown>>; datasets: Record<string, unknown>[] };
const kudosDataset = example.datasets[0] as { options: Record<string, unknown> } & Record<
  string,
  unknown
>;

const corpora = {
  kudos: {
    docs: 'KUDOS_preprod_v4_documents_ab897fbdedfa',
    chunks: 'KUDOS_preprod_v4_chunks_ab897fbdedfa',
    phrases: 'KUDOS_preprod_v4_phrases_ab897fbdedfa',
  },
  website: {
    docs: 'website_documents_ab897fbdedfa',
    chunks: 'website_chunks_ab897fbdedfa',
    phrases: 'website_phrases_ab897fbdedfa',
  },
};

const router = new KnowledgeRouter({
  catalog: {
    endpoints: { 'kudos-typesense': { ...example.endpoints['kudos-typesense'], baseURL } },
    datasets: Object.entries(corpora).map(([id, collections]) => ({
      ...kudosDataset,
      id: `probe/${id}`,
      ...(id === 'kudos' ? {} : { filters: {} }),
      options: {
        ...kudosDataset.options,
        collections,
        docFields:
          id === 'kudos'
            ? ['url', 'title', 'total_chunks', 'type', 'concerned_years', 'orgs_long']
            : ['url', 'title', 'total_chunks'],
      },
    })),
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

const open = (id: keyof typeof corpora): KnowledgePort =>
  router.open({ kind: 'dataset', id: `probe/${id}` }, context);

const today = new Date().toISOString().slice(0, 10);
const testsets = join(import.meta.dirname, '..', '..', 'testsets');

const golden = async (write: boolean) => {
  for (const file of ['headless-rag-ue-42.yaml', 'headless-rag-website-118.yaml']) {
    const raw = parseYaml(readFileSync(join(testsets, file), 'utf8')) as TestSet;
    let best: { corpus: string; result: Awaited<ReturnType<typeof mapSources>> } | undefined;
    for (const corpus of Object.keys(corpora) as (keyof typeof corpora)[]) {
      const port = open(corpus);
      const result = await mapSources(raw, (ids) => port.fetch(ids), today, corpora[corpus].chunks);
      console.log(
        JSON.stringify({ file, corpus, mapped: result.mapped, missing: result.missing.length }),
      );
      if (!best || result.mapped > best.result.mapped) best = { corpus, result };
    }
    if (!write || !best) continue;
    const updated =
      best.result.mapped === 0
        ? unreachable(
            raw,
            today,
            Object.values(corpora).map((c) => c.chunks),
          )
        : best.result.set;
    writeFileSync(join(testsets, file), testSetYaml(updated));
  }
};

const sample = async (out: string) => {
  const candidates = await sampleCandidates({
    facets: (fields) => open('kudos').facets(fields),
    search: (request) => open('kudos').search(request as Parameters<KnowledgePort['search']>[0]),
    fetch: (ids) => open('kudos').fetch(ids),
  });
  writeFileSync(out, JSON.stringify(candidates, null, 2));
  console.log(JSON.stringify({ candidates: candidates.length, out }));
};

const [command, arg] = process.argv.slice(2);
if (command === 'golden') await golden(arg === '--write');
else if (command === 'sample' && arg) await sample(arg);
else throw new Error('usage: kudos-live golden [--write] | kudos-live sample <out.json>');
