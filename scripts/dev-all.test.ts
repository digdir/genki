import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import {
  devProcesses,
  localModelPort,
  portInUse,
  prefixer,
  repoRoot,
  runAll,
  type DevProcess,
} from './dev-all.ts';

const portOf = (name: string) => devProcesses({}).find((p) => p.name === name)?.port;
const apiEnv = (env: Record<string, string>) =>
  devProcesses(env).find((p) => p.name === 'api')?.env;

describe('dev:all', () => {
  it('runs each app on the port its vite config expects, through the BFF of the API', () => {
    for (const app of ['portal', 'console']) {
      const vite = readFileSync(join(repoRoot, `apps/${app}/vite.config.ts`), 'utf8');
      expect(vite).toContain(`port: ${portOf(app)}`);
      expect(vite).toContain('`http://localhost:${process.env.GENAI_API_PORT ?? 8080}`');
      expect(vite).toContain('process.env.GENAI_PROXY_KEY');
    }
    expect(portOf('api')).toBe(8080);
  });

  it('signs the apps in locally through the platform login, with one proxy key for the API and the apps', () => {
    const processes = devProcesses({});
    const api = processes.find((p) => p.name === 'api')?.env ?? {};
    expect(api).toMatchObject({
      PLATFORM_LOGIN_CLIENT_ID: 'genki-platform-login-local',
      PLATFORM_LOGIN_HOSTNAME: 'localhost',
      PLATFORM_LOGIN_ORIGIN: 'http://localhost:5173',
      PLATFORM_APP_ORIGINS:
        'portal=http://portal.localhost:5173,console=http://console.localhost:5174',
    });
    expect(api.GENAI_PROXY_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(api.PLATFORM_LOGIN_CLIENT_SECRET).toBeTruthy();
    for (const app of ['portal', 'console'])
      expect(processes.find((p) => p.name === app)?.env?.GENAI_PROXY_KEY).toBe(api.GENAI_PROXY_KEY);
  });

  it('gives the apps no proxy key outside dev mode, where the API has none to check it against', () => {
    const processes = devProcesses({ GENAI_DEV_MODE: 'false' });
    for (const name of ['api', 'portal', 'console'])
      expect(processes.find((p) => p.name === name)?.env).not.toHaveProperty('GENAI_PROXY_KEY');
  });

  it('keeps a TEST Ansattporten client from .env.local for the platform login', () => {
    const api = apiEnv({
      ANSATTPORTEN_ISSUER: 'https://test.ansattporten.no',
      PLATFORM_LOGIN_CLIENT_ID: 'my-test-client',
      PLATFORM_LOGIN_CLIENT_SECRET: 'from-env-local',
    });
    expect(api).not.toHaveProperty('PLATFORM_LOGIN_CLIENT_ID');
    expect(api).not.toHaveProperty('PLATFORM_LOGIN_CLIENT_SECRET');
    expect(api).toMatchObject({ PLATFORM_LOGIN_ORIGIN: 'http://localhost:5173' });
  });

  it('starts the local test model only when LOCAL_MODEL_URL points to this machine', () => {
    expect(portOf('model')).toBeUndefined();
    expect(
      devProcesses({ LOCAL_MODEL_URL: 'http://127.0.0.1:8095/v1' }).find((p) => p.name === 'model'),
    ).toMatchObject({ port: 8095, env: { LOCAL_MODEL_PORT: '8095' } });
    expect(localModelPort('https://models.example.no/v1')).toBeUndefined();
    expect(localModelPort('not a url')).toBeUndefined();
  });

  it('passes LOCAL_MODEL_RESPONSES from .env.local to the local test model', () => {
    expect(
      devProcesses({
        LOCAL_MODEL_URL: 'http://127.0.0.1:8095/v1',
        LOCAL_MODEL_RESPONSES: '/tmp/answers',
      }).find((p) => p.name === 'model')?.env,
    ).toEqual({ LOCAL_MODEL_PORT: '8095', LOCAL_MODEL_RESPONSES: '/tmp/answers' });
  });

  it('starts the API in dev mode unless GENAI_DEV_MODE is set', () => {
    expect(apiEnv({})).toMatchObject({ GENAI_DEV_MODE: 'true' });
    expect(apiEnv({ GENAI_DEV_MODE: 'false' })).toEqual({});
  });

  it('serves the block origin on its own port in dev mode, and never outside it', () => {
    const api = (env: Record<string, string>) => devProcesses(env).find((p) => p.name === 'api');

    expect(api({})?.env).toMatchObject({
      GENAI_BLOCK_ORIGIN: 'http://localhost:8090',
      GENAI_BLOCK_PORT: '8090',
    });
    expect(api({ GENAI_BLOCK_PORT: '8190' })?.env).toMatchObject({
      GENAI_BLOCK_ORIGIN: 'http://localhost:8190',
    });
    expect(api({ GENAI_DEV_MODE: 'false' })?.env).not.toHaveProperty('GENAI_BLOCK_ORIGIN');
  });

  it('starts the worker beside the API, so runs on the knowledge database have someone to work them', () => {
    const worker = devProcesses({}).find((p) => p.name === 'worker');
    expect(worker).toMatchObject({
      port: 8081,
      args: expect.arrayContaining(['dev', '--workspace', 'apps/worker']),
      env: { GENAI_DEV_MODE: 'true' },
    });
    expect(
      devProcesses({ GENAI_API_PORT: '8100', GENAI_WORKER_PORT: '8104' }).find(
        (p) => p.name === 'worker',
      ),
    ).toMatchObject({ port: 8104, env: { WORKER_HEALTH_PORT: '8104' } });
  });

  it('runs the API as the test tier in dev mode unless GENAI_ENV is set', () => {
    expect(apiEnv({})).toMatchObject({ GENAI_ENV: 'test' });
    expect(apiEnv({ GENAI_DEV_MODE: 'true' })).toMatchObject({ GENAI_ENV: 'test' });
    expect(apiEnv({ GENAI_ENV: 'local' })).not.toHaveProperty('GENAI_ENV');
  });

  it('gives the mock persons their mock rights in dev mode, even when ALTINN_PDP_URL is set', () => {
    expect(apiEnv({ ALTINN_PDP_URL: 'https://platform.tt02.altinn.no' })).toMatchObject({
      GENAI_MOCK_RIGHTS: 'true',
    });
  });

  it('asks the real Altinn PDP when GENAI_MOCK_RIGHTS=false or the login is real Ansattporten', () => {
    expect(apiEnv({ GENAI_MOCK_RIGHTS: 'false' })).not.toHaveProperty('GENAI_MOCK_RIGHTS');
    expect(apiEnv({ ANSATTPORTEN_ISSUER: 'https://test.ansattporten.no' })).not.toHaveProperty(
      'GENAI_MOCK_RIGHTS',
    );
  });

  it('moves every app to the ports given in GENAI_*_PORT and points the apps at that API', () => {
    const processes = devProcesses({
      GENAI_API_PORT: '8100',
      GENAI_PORTAL_PORT: '8101',
      GENAI_CONSOLE_PORT: '8102',
    });
    const byName = Object.fromEntries(processes.map((p) => [p.name, p]));

    expect(processes.map((p) => [p.name, p.port])).toEqual([
      ['api', 8100],
      ['worker', 8081],
      ['portal', 8101],
      ['console', 8102],
    ]);
    expect(byName.api?.env).toMatchObject({ GENAI_DEV_MODE: 'true', PORT: '8100' });
    expect(byName.console?.env).toMatchObject({
      GENAI_API_PORT: '8100',
      VITE_PUBLIC_API_BASE: 'http://localhost:8100',
    });
    expect(byName.api?.env).toMatchObject({
      PLATFORM_LOGIN_ORIGIN: 'http://localhost:8101',
      PLATFORM_APP_ORIGINS:
        'portal=http://portal.localhost:8101,console=http://console.localhost:8102',
    });
    expect(byName.portal?.args).toEqual(expect.arrayContaining(['--port', '8101']));
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

  it('stops the rest when a command cannot start', async () => {
    const lines: string[] = [];
    const run = runAll(
      [forever('stays'), { name: 'gone', port: 0, command: 'no-such-command-genki', args: [] }],
      { cwd: repoRoot, colour: false, write: (t) => lines.push(t) },
    );
    const pids = run.pids();
    expect(await run.exited).toBe(1);
    expect(lines.join('')).toContain('gone  | could not start');
    expect(alive(pids[0])).toBe(false);
  });

  it('stops the processes a child started, as npm starts the servers', async () => {
    const lines: string[] = [];
    const grandchild = `require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid`;
    const run = runAll([forever('parent', `console.log('child ' + ${grandchild});`)], {
      cwd: repoRoot,
      colour: false,
      write: (t) => lines.push(t),
    });
    await vi.waitFor(() => expect(lines.join('')).toMatch(/child \d+/));
    const pid = Number(/child (\d+)/.exec(lines.join(''))?.[1]);
    run.stop(0);
    await run.exited;
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
  });
});
