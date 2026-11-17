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

// A public KUDOS report as the knowledge database holds one made from a stored conversion: its
// record's files, and chunks with their file, pages and heading path, the text as on those pages
// of the PDF. Its file is real, so «Les side N» and Dokumentvisning open the right page (issue 642).
const sykepengerUuid = 'a3313528-5945-4149-b8e6-e45215a3cd02';
const sykepengerFile = {
  uuid: 'a3313a88-2c8c-4b69-b05f-c641e23156db',
  url: `https://kudos.dfo.no/dokument/${sykepengerUuid}/filer/a3313a88-2c8c-4b69-b05f-c641e23156db.pdf`,
  sha256: 'ec49e9922a2954de4cf1ca8a1832432146a0856d41e893669eb9a3906c99c5ba',
  mimetype: 'application/pdf',
  pages: 39,
};
const sykepengerChunk = (
  position: number,
  pages: [number, number],
  headingPath: string[],
  text: string,
) => ({
  id: `kudos:${sykepengerUuid}#${position}`,
  position,
  text,
  file: 'sykepenger.pdf',
  fileSha256: sykepengerFile.sha256,
  pageFrom: pages[0],
  pageTo: pages[1],
  ...(headingPath.length ? { headingPath } : {}),
});
const sykepenger = {
  id: `kudos:${sykepengerUuid}`,
  title: 'Rapport for 2025 om utbetaling av sykepenger i Nav',
  url: `https://kudos.dfo.no/dokument/${sykepengerUuid}`,
  fields: { type: ['rapport'], files: [sykepengerFile], file_sha256: [sykepengerFile.sha256] },
  chunks: [
    sykepengerChunk(
      0,
      [2, 2],
      [],
      'Revisjonen er gjennomført som en del av Riksrevisjonens kontroll av disposisjoner i henhold til lov om Riksrevisjonen, INTOSAIs standard for etterlevelsesrevisjon (ISSAI 4000) og Riksrevisjonens faglige retningslinjer for etterlevelsesrevisjon.',
    ),
    sykepengerChunk(
      1,
      [6, 7],
      ['1 Sammendrag'],
      'Sykepenger er en økonomisk støtteordning som forvaltes av Nav. I 2025 mottok Nav 3,4 millioner digitale søknader om sykepenger og utbetalte i overkant av 63 milliarder kroner til arbeidstakere, frilansere og selvstendig næringsdrivende. Vi konkluderer med at Nav ikke i tilstrekkelig grad sikrer at sykepengeutbetalingene i saksbehandlingssystemet Speil er i henhold til folketrygdloven og økonomireglementet.',
    ),
    sykepengerChunk(
      2,
      [9, 9],
      ['2.3 Risiko ved utbetaling av sykepenger'],
      'Nav opplyser at det i 2025 ble tatt ut 468 801 varsler til manuell saksbehandling i Speil. De fleste sykepengesøknadene behandles automatisk. De innebygde kontrollene i Speil og risikomodulen skal sikre at regelverket følges, slik at sykepengeutbetalingene blir korrekte.',
    ),
  ],
  phrases: [],
} satisfies IndexDocument;

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
  sykepenger,
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
  // The shipped catalog has no knowledge endpoint, since a deployed API without a knowledge server would refuse to start.
  console.log(`${values.dataset}: generation ${values.generation} with ${documents.length} documents.
In apps/api/config/local/knowledge.yaml (do not commit it), then restart the API:

Add under \`endpoints:\`
  knowledge-pg:
    engine: pgvector
    options: { connection: knowledge }

Add under \`datasets:\`
  - id: ${values.dataset}
    endpoint: knowledge-pg
    residency: norway
    filters: { type: multiselect }
    generation: ${values.generation}
    options: { textSearchConfig: norwegian }`);
} finally {
  await pools.close();
  await platform.end();
}
