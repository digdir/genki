/**
 * Heading parts of genki's `docling-parts` 2 (issue 516) as blocks.jsonl, so headings_vs_outline.py and
 * heading_levels_score.py can score their levels against the PDFs' own outlines. Run from the repository root:
 *
 *     npx tsx --conditions=source benchmarks/ingestion/blocks/heading_levels_parts.ts <docling dir> <pdf dir> <out> [<layout cache>]
 *
 * <docling dir> holds <first 2 hex>/<sha256>/docling.json, <pdf dir> holds <sha256>.pdf. For every PDF, writes
 * <out>/parts/<sha256>/blocks.jsonl (levels from section number and text size, outline rung off) and
 * <out>/parts-box/<sha256>/blocks.jsonl (the same with no text layer: box height only, as on scans), and
 * <out>/timings.jsonl: how long `readPdfLayout` took per document, with its pages, runs and outline entries.
 * A block is {page, bbox, kind, level, text}: page from 1, bbox as fractions from the top left, kind `title` or
 * `heading`, only the body layer's titles and section headers. With <layout cache>, each PDF's layout (outline
 * and text sizes, no text) is kept there as <sha256>.json and read back on the next run, to try rules quickly;
 * timings are then only written for layouts read from the PDF.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { doclingParts, type PdfLayout } from '@genai/ingest';
import { readPdfLayout } from '@genai/providers-documents';

const [doclingDir, pdfDir, out, cache] = process.argv.slice(2);
if (!doclingDir || !pdfDir || !out)
  throw new Error('usage: heading_levels_parts.ts <docling dir> <pdf dir> <out>');

const write = (variant: string, sha: string, document: unknown, layout: PdfLayout) => {
  const { units } = doclingParts(document as Parameters<typeof doclingParts>[0], {
    layout,
    outline: false,
  });
  const lines = units
    .flatMap((unit) => unit.parts)
    .filter(
      (part) =>
        part.layer === 'body' &&
        part.text !== '' &&
        (part.kind === 'title' || part.kind === 'section_header'),
    )
    .sort((a, b) => a.seq - b.seq)
    .map((part) => {
      const region = part.regions[0];
      return JSON.stringify({
        page: region?.unit ?? null,
        bbox: region?.box ?? null,
        kind: part.kind === 'title' ? 'title' : 'heading',
        level: part.level,
        text: part.text,
      });
    });
  const folder = join(out, variant, sha);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'blocks.jsonl'), lines.map((line) => `${line}\n`).join(''));
};

mkdirSync(out, { recursive: true });
const timings = join(out, 'timings.jsonl');
writeFileSync(timings, '');
const shas = readdirSync(pdfDir)
  .filter((name) => name.endsWith('.pdf'))
  .map((name) => name.slice(0, -4))
  .sort();
for (const sha of shas) {
  const document = JSON.parse(
    readFileSync(join(doclingDir, sha.slice(0, 2), sha, 'docling.json'), 'utf8'),
  ) as { pages?: Record<string, unknown> };
  const cached = cache ? join(cache, `${sha}.json`) : undefined;
  if (cached && existsSync(cached)) {
    const layout = JSON.parse(readFileSync(cached, 'utf8')) as PdfLayout;
    write('parts', sha, document, layout);
    write('parts-box', sha, document, { outline: layout.outline, runs: [] });
    continue;
  }
  const bytes = readFileSync(join(pdfDir, `${sha}.pdf`));
  const started = performance.now();
  let layout: PdfLayout;
  try {
    layout = await readPdfLayout(new Uint8Array(bytes));
  } catch (error) {
    appendFileSync(timings, `${JSON.stringify({ sha, error: String(error).slice(0, 200) })}\n`);
    continue;
  }
  const ms = performance.now() - started;
  appendFileSync(
    timings,
    `${JSON.stringify({
      sha,
      ms: Math.round(ms),
      pages: Object.keys(document.pages ?? {}).length,
      bytes: bytes.length,
      runs: layout.runs.length,
      outline: layout.outline.length,
    })}\n`,
  );
  if (cache && cached) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(cached, JSON.stringify(layout));
  }
  write('parts', sha, document, layout);
  write('parts-box', sha, document, { outline: layout.outline, runs: [] });
}
console.log(`heading parts written for ${shas.length} documents`);
