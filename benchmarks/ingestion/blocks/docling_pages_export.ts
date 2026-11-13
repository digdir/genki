/**
 * One page's Markdown per file from genki's page builder `doclingPages` (derivation `docling-pages` 1),
 * for page_tests_docling_pages.py. Run from the repository root:
 *
 *     npx tsx --conditions=source benchmarks/ingestion/blocks/docling_pages_export.ts <pages.json> <out>
 *
 * <pages.json> is a list of {"page_id", "docling", "page"}: the path of a DoclingDocument JSON file and the
 * page counted from 1. Writes <out>/<page_id>.md, empty for a page the builder returns nothing for.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { doclingPages, type DoclingDocument } from '../../../packages/ingest/src/docling-pages.ts';

interface Wanted {
  page_id: string;
  docling: string;
  page: number;
}

const [pagesFile, out] = process.argv.slice(2);
if (!pagesFile || !out) throw new Error('usage: docling_pages_export.ts <pages.json> <out>');

const wanted = JSON.parse(readFileSync(pagesFile, 'utf8')) as Wanted[];
const byFile = new Map<string, Wanted[]>();
for (const p of wanted) byFile.set(p.docling, [...(byFile.get(p.docling) ?? []), p]);

mkdirSync(out, { recursive: true });
let written = 0;
for (const [file, pages] of byFile) {
  const markdown = doclingPages(JSON.parse(readFileSync(file, 'utf8')) as DoclingDocument);
  for (const p of pages) {
    writeFileSync(join(out, `${p.page_id}.md`), markdown[p.page - 1] ?? '');
    written += 1;
  }
}
console.log(`docling-pages: ${written} pages written from ${byFile.size} documents`);
