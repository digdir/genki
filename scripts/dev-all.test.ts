import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createServer } from 'node:net';
import {
  devProcesses,
  localModelPort,
  missingCallbacks,
  portInUse,
  prefixer,
  repoRoot,
  runAll,
  type DevProcess,
} from './dev-all.ts';

const portOf = (name: string) => devProcesses({}).find((p) => p.name === name)?.port;

describe('dev:all', () => {
  it('runs each app on the port its vite config and OIDC client expect', () => {
    const identity = parse(
      readFileSync(join(repoRoot, 'apps/api/config/local/identity.yaml'), 'utf8'),
    ) as { clients: { clientId: string; redirectUris: string[] }[] };
    for (const app of ['portal', 'console', 'workspace']) {
      const port = portOf(app);
      const vite = readFileSync(join(repoRoot, `apps/${app}/vite.config.ts`), 'utf8');
      expect(vite).toContain(`port: ${port}`);
      expect(vite).toContain('target: `http://localhost:${process.env.GENAI_API_PORT ?? 8080}`');
      const client = identity.clients.find((c) => c.clientId === `local-${app}`);
      expect(client?.redirectUris).toContain(`http://localhost:${port}/callback`);
    }
    expect(portOf('api')).toBe(8080);
  });

  it('starts the local test model only when LOCAL_MODEL_URL points to this machine', () => {
    expect(portOf('model')).toBeUndefined();
    expect(
      devProcesses({ LOCAL_MODEL_URL: 'http://127.0.0.1:8095/v1' }).find((p) => p.name === 'model'),
    ).toMatchObject({ port: 8095, env: { LOCAL_MODEL_PORT: '8095' } });
    expect(localModelPort('https://models.example.no/v1')).toBeUndefined();
    expect(localModelPort('not a url')).toBeUndefined();
  });

  it('starts the API in dev mode unless GENAI_DEV_MODE is set', () => {
    const api = (env: Record<string, string>) =>
      devProcesses(env).find((p) => p.name === 'api')?.env;
    expect(api({})).toEqual({ GENAI_DEV_MODE: 'true' });
    expect(api({ GENAI_DEV_MODE: 'false' })).toEqual({});
  });

  it('points the workspace portal link at the dev:all portal', () => {
    expect(devProcesses({}).find((p) => p.name === 'workspace')?.env).toEqual({
      VITE_PORTAL_URL: `http://localhost:${portOf('portal')}`,
    });
  });

  it('moves every app to the ports given in GENAI_*_PORT and points the apps at that API', () => {
    const processes = devProcesses({
      GENAI_API_PORT: '8100',
      GENAI_PORTAL_PORT: '8101',
      GENAI_CONSOLE_PORT: '8102',
      GENAI_WORKSPACE_PORT: '8103',
    });
    const byName = Object.fromEntries(processes.map((p) => [p.name, p]));

    expect(processes.map((p) => [p.name, p.port])).toEqual([
      ['api', 8100],
      ['portal', 8101],
      ['console', 8102],
      ['workspace', 8103],
    ]);
    expect(byName.api?.env).toEqual({ GENAI_DEV_MODE: 'true', PORT: '8100' });
    expect(byName.console?.env).toEqual({
      GENAI_API_PORT: '8100',
      VITE_PUBLIC_API_BASE: 'http://localhost:8100',
      VITE_ANSATTPORTEN_ISSUER: 'http://localhost:8100/mock/ansattporten',
      VITE_OIDC_ISSUER: 'http://localhost:8100/mock/ansattporten',
    });
    expect(byName.workspace?.env).toMatchObject({ VITE_PORTAL_URL: 'http://localhost:8101' });
    expect(byName.portal?.args).toEqual(expect.arrayContaining(['--port', '8101']));
  });

  it('keeps a login issuer set in the environment when the API port moves', () => {
    const portal = devProcesses({
      GENAI_API_PORT: '8100',
      VITE_ANSATTPORTEN_ISSUER: 'https://login.example.no',
    }).find((p) => p.name === 'portal');

    expect(portal?.env?.VITE_ANSATTPORTEN_ISSUER).toBeUndefined();
  });

  it('accepts registered mock loopback callbacks on other ports', () => {
    const identity = readFileSync(join(repoRoot, 'apps/api/config/local/identity.yaml'), 'utf8');

    expect(missingCallbacks(identity, devProcesses({}))).toEqual([]);
    expect(
      missingCallbacks(
        identity,
        devProcesses({
          GENAI_PORTAL_PORT: '8101',
          GENAI_CONSOLE_PORT: '8102',
          GENAI_WORKSPACE_PORT: '8103',
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    'http://localhost:5174/other',
    'http://127.0.0.1:5174/callback',
    'https://localhost:5174/callback',
    'http://evil.test:5174/callback',
    'http://localhost:70000/callback',
    'http://localhost:5174/callback\n',
  ])('still names a missing mock callback when only %s is registered', (uri) => {
    const identity = JSON.stringify({
      clients: [{ clientId: 'local-console', redirectUris: [uri] }],
    });
    expect(missingCallbacks(identity, devProcesses({ GENAI_CONSOLE_PORT: '8102' }))).toEqual([
      'local-console http://localhost:8102/callback',
    ]);
  });

  it('prefixes every complete line and holds a partial line until it ends', () => {
    const out: string[] = [];
    const p = prefixer('api |', (text) => out.push(text));
    p.push('one\ntw');
    p.push('o\nthree');
    expect(out).toEqual(['api | one\n', 'api | two\n']);
    p.flush();
    expect(out.at(-1)).toBe('api | three\n');
  });

  it('sees a port as taken when something listens on localhost only', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    expect(await portInUse(port)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await portInUse(port)).toBe(false);
  });

  const alive = (pid: number | undefined) => {
    try {
      process.kill(pid ?? -1, 0);
      return true;
    } catch {
      return false;
    }
  };
  const forever = (name: string, extra = ''): DevProcess => ({
    name,
    port: 0,
    command: process.execPath,
    args: ['-e', `console.log('up'); ${extra} setInterval(() => {}, 1000)`],
  });

  it('prefixes child output and stops every child on stop', async () => {
    const lines: string[] = [];
    const run = runAll([forever('one'), forever('two')], {
      cwd: repoRoot,
      colour: false,
      write: (t) => lines.push(t),
    });
    await vi.waitFor(() =>
      expect(lines).toEqual(expect.arrayContaining(['one | up\n', 'two | up\n'])),
    );
    const pids = run.pids();
    run.stop(0);
    expect(await run.exited).toBe(0);
    expect(pids.map(alive)).toEqual([false, false]);
  });

  it('stops the rest when one child exits on its own', async () => {
    const lines: string[] = [];
    const run = runAll(
      [forever('stays'), forever('dies', 'setTimeout(() => process.exit(3), 200);')],
      {
        cwd: repoRoot,
        colour: false,
        write: (t) => lines.push(t),
      },
    );
    const pids = run.pids();
    expect(await run.exited).toBe(3);
    expect(lines.join('')).toContain('dies  | stopped (exit 3), stopping the rest');
    expect(pids.map(alive)).toEqual([false, false]);
  });
});
