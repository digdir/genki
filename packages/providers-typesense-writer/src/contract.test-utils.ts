import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractSchemas } from './index.js';

const contractDir = join(import.meta.dirname, '..', '..', 'providers-typesense', 'src', 'contract');
export const contractSchemas = (): ContractSchemas => ({
  docs: JSON.parse(
    readFileSync(join(contractDir, 'docs.schema.json'), 'utf8'),
  ) as ContractSchemas['docs'],
  chunks: JSON.parse(
    readFileSync(join(contractDir, 'chunks.schema.json'), 'utf8'),
  ) as ContractSchemas['chunks'],
  phrases: JSON.parse(
    readFileSync(join(contractDir, 'phrases.schema.json'), 'utf8'),
  ) as ContractSchemas['phrases'],
});
