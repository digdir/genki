import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');

describe('an unhandled promise rejection in a request handler', () => {
  it('leaves the API answering other requests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unhandled-rejection-'));
    const script = join(dir, 'probe.mts');
    writeFileSync(
      script,
      `import { Hono } from ${JSON.stringify(join(root, 'node_modules', 'hono', 'dist', 'index.js'))};
import { keepRunningOnRejection } from ${JSON.stringify(join(root, 'packages', 'composition', 'src', 'process-guard.ts'))};
keepRunningOnRejection((msg, fields) => console.log(JSON.stringify({ msg, ...fields })));
const app = new Hono();
app.get('/leak', (c) => {
  void Promise.reject(new Error('nobody awaits this'));
  return c.text('leaked');
});
app.get('/health', (c) => c.text('ok'));
console.log((await app.request('/leak')).status);
await new Promise((resolve) => setTimeout(resolve, 200));
console.log('health ' + (await app.request('/health')).status);
`,
    );
    const result = spawnSync(process.execPath, ['--conditions=source', '--import', 'tsx', script], {
      cwd: join(root, 'apps', 'api'),
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('unhandled promise rejection');
    expect(output).toContain('health 200');
    expect(result.status).toBe(0);
  }, 60_000);
});
