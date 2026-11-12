import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { conversionStoreFromEnv } from '@genai/providers-azure-blob';

// Writes, reads back and deletes one probe conversion in the conversions store the worker uses
// (CONVERSIONS_BLOB_URL in Azure, a folder under DATA_DIR locally). Run on the worker:
// az containerapp exec -n <worker app> -g <group> --command "node scripts/conversions-check.ts"
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'apps', 'api', '.data');

const main = async () => {
  const { store } = await conversionStoreFromEnv(process.env, dataDir);
  const where = process.env.CONVERSIONS_BLOB_URL ?? join(dataDir, 'conversions');
  const key = {
    sha256: createHash('sha256').update('genki conversions check').digest('hex'),
    converter: 'check',
    version: '1',
    settings: {},
  };
  const output = new TextEncoder().encode(JSON.stringify({ checkedAt: new Date().toISOString() }));
  const entry = await store.put(key, output, 0);
  const found = await store.get(key);
  const same = found !== undefined && Buffer.from(found.output).equals(Buffer.from(output));
  const listed = (await store.list(key.sha256)).some((e) => e.path === entry.path);
  await store.delete(key);
  console.log(
    `${where}: wrote ${entry.path}, read it back ${same ? 'unchanged' : 'CHANGED'}, ${listed ? 'listed it' : 'did NOT list it'}, deleted it`,
  );
  if (!same || !listed) process.exit(1);
};

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
