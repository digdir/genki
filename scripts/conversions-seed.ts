// Sends a seed of stored conversions from native output already in Blob (ADR 0042, issue 474): one
// knowledge.seed job per two-character sha256 prefix, which the worker works. The defaults are the
// Docling export of KUDOS, as pages; `--derivation docling-parts` stores parts instead (ADR 0055),
// and `--prefixes 00,01` sends only those batches. On the worker in Azure: `node scripts/conversions-seed.ts`.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { seedPrefixes, sendSeed } from '@genai/jobs';
import { PgBossJobQueue } from '@genai/providers-pgboss';
import { openKnowledgePools } from '@genai/providers-pgvector';
import { knowledgeSourceFromEnv } from '@genai/providers-postgres';
import type { Pool } from 'pg';

const envFile = join(import.meta.dirname, '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
  options: {
    converter: { type: 'string', default: 'docling' },
    version: { type: 'string', default: '2.123.1' },
    settings: {
      type: 'string',
      default: 'b48834151e40e32998687534cdd32f6cfce37fe3672d96f76c235f50fdff3f6f',
    },
    derivation: { type: 'string' },
    prefixes: { type: 'string' },
  },
});

if (values.derivation !== undefined && values.derivation !== 'docling-parts')
  throw new Error('--derivation takes docling-parts, or leave it out for pages');
const prefixes = values.prefixes ? values.prefixes.split(',') : seedPrefixes;
const unknown = prefixes.filter((p) => !seedPrefixes.includes(p));
if (unknown.length > 0) throw new Error(`not two hex characters: ${unknown.join(', ')}`);

const source = knowledgeSourceFromEnv(process.env, 'worker');
if (!source) throw new Error('set KNOWLEDGE_DATABASE_URL, as the worker has it');
const pools = openKnowledgePools(source, 'worker');
const queue = await PgBossJobQueue.start(pools.pools.writer as Pool, { works: false });
try {
  const target = {
    converter: values.converter,
    version: values.version,
    settings: values.settings,
    ...(values.derivation ? { derivation: 'docling-parts' as const } : {}),
  };
  const sent = await sendSeed(queue, target, prefixes);
  console.log(
    `sent ${sent} of ${prefixes.length} seed jobs for ${target.converter} ${target.version} ${target.settings.slice(0, 12)}… as ${values.derivation ?? 'pages'}; a batch whose job still waits or runs is not sent again`,
  );
} finally {
  await queue.stop();
  await pools.close();
}
