// Writes a small demo generation onto the local knowledge server, as the worker's login would,
// so a `connection: knowledge` dataset can be searched before ingestion runs there (issue 139).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { DatasetConfig, IndexDocument } from '@genai/port-knowledge';
import { openKnowledgePools, pgvectorEngine } from '@genai/providers-pgvector';
import { knowledgeSourceFromEnv } from '@genai/providers-postgres';
import pg from 'pg';

const envFile = join(import.meta.dirname, '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
  options: {
    dataset: { type: 'string', default: 'digdir/knowledge-demo' },
    generation: { type: 'string', default: 'g-local-demo' },
  },
});

const source = knowledgeSourceFromEnv(process.env, 'worker');
if (!process.env.KNOWLEDGE_DATABASE_URL || !source)
  throw new Error('set KNOWLEDGE_DATABASE_URL and KNOWLEDGE_WORKER_PASSWORD (npm run setup does)');

const doc = (id: string, title: string, fields: Record<string, unknown>, texts: string[]) =>
  ({
    id,
    title,
    fields,
    chunks: texts.map((text, position) => ({ id: `${id}#${position}`, position, text })),
    phrases: [],
  }) satisfies IndexDocument;

const documents = [
  doc('tilskudd-2024', 'Tilskudd til digitalisering 2024', { type: ['rapport'] }, [
    'Kommunene kan søke tilskudd til digitalisering av tjenester.',
    'Søknaden sendes innen 1. mars, og rapporten leveres året etter.',
  ]),
  doc('lonn-2023', 'Lønnsstatistikk for staten 2023', { type: ['statistikk'] }, [
    'Lønnsutviklingen i staten var 5,2 prosent i 2023.',
  ]),
  doc('sky-veileder', 'Veileder for skytjenester', { type: ['veileder'] }, [
    'Virksomheter som tar i bruk skytjenester bør gjøre en risikovurdering først.',
  ]),
];

const dataset: DatasetConfig = {
  id: values.dataset,
  filters: { type: 'multiselect' },
  options: { textSearchConfig: 'norwegian' },
};

const pools = openKnowledgePools(source, 'worker');
const platform = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const writer = pgvectorEngine({ pool: platform, knowledge: pools.pools }).writer.connect(
    { options: { connection: 'knowledge' }, timeoutMs: 30_000 },
    { signal: new AbortController().signal },
  );
  await writer.prepare(dataset, values.generation);
  for (const document of documents) await writer.store(dataset, values.generation, document);
  await writer.promote(dataset, values.generation);
  console.log(
    `${values.dataset}: generation ${values.generation} with ${documents.length} documents; name it as \`generation\` in the dataset's catalog entry`,
  );
} finally {
  await pools.close();
  await platform.end();
}
