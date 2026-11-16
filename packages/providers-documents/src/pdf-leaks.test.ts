import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pdfWithBrokenPages } from './testing/index.js';
import { createLocalConverter } from './index.js';

const here = import.meta.dirname;

/** Runs a script in a fresh Node process, as the worker runs, and returns its exit code and output. */
const run = (body: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-leaks-'));
  const script = join(dir, 'probe.mts');
  writeFileSync(
    script,
    `import { createLocalConverter, guardPdfParseLeaks } from ${JSON.stringify(join(here, 'index.ts'))};
import { pdfWithBrokenPages } from ${JSON.stringify(join(here, 'testing', 'index.ts'))};
${body}
await new Promise((resolve) => setTimeout(resolve, 500));
console.log('still running');
`,
  );
  const result = spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', script], {
    cwd: join(here, '..', '..', '..'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

describe('pdf.js parse errors', () => {
  it('a PDF page the text layer cannot read is left empty when converted, and the rest is kept', async () => {
    const unreadable: number[] = [];
    const conversion = await createLocalConverter({
      onUnreadablePage: (page) => unreadable.push(page.page),
    }).convert({ name: 'rapport.pdf', bytes: pdfWithBrokenPages(['One', 'Two', 'Three'], [2]) });

    expect(conversion.pages).toEqual(['One', '', 'Three']);
    expect(unreadable).toEqual([2]);
  });

  it('a PDF with several unreadable pages leaves the process running', () => {
    const { status, output } = run(`
guardPdfParseLeaks((msg) => console.log(msg));
const conversion = await createLocalConverter().convert({
  name: 'rapport.pdf',
  bytes: pdfWithBrokenPages(['One', 'Two', 'Three'], [2, 3]),
});
console.log(JSON.stringify(conversion.pages));
`);

    expect(output).toContain('["One","",""]');
    expect(output).toContain('still running');
    expect(status).toBe(0);
  }, 60_000);

  it('any other unhandled rejection still ends the process', () => {
    const { status, output } = run(`
guardPdfParseLeaks((msg) => console.log(msg));
void Promise.reject(new Error('a bug elsewhere'));
`);

    expect(output).not.toContain('still running');
    expect(status).not.toBe(0);
  }, 60_000);
});
