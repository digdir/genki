import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { npmCommand } from './setup.ts';

export const repoRoot = join(import.meta.dirname, '..');

export interface DevProcess {
  name: string;
  port: number;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const vite = (name: string, port: number, env: Record<string, string> = {}): DevProcess => ({
  name,
  port,
  ...npmCommand([
    'run',
    'dev',
    '--workspace',
    `apps/${name}`,
    '--',
    '--port',
    String(port),
    '--strictPort',
  ]),
  env,
});

export const localModelPort = (url: string | undefined): number | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost'].includes(parsed.hostname)) return undefined;
    return Number(parsed.port || 80);
  } catch {
    return undefined;
  }
};

export const defaultPorts = {
  api: 8080,
  worker: 8081,
  portal: 5173,
  console: 5174,
  workspace: 5176,
  block: 8090,
};

export const devPorts = (env: Record<string, string | undefined>) => {
  const pick = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    api: pick('GENAI_API_PORT', defaultPorts.api),
    worker: pick('GENAI_WORKER_PORT', defaultPorts.worker),
    portal: pick('GENAI_PORTAL_PORT', defaultPorts.portal),
    console: pick('GENAI_CONSOLE_PORT', defaultPorts.console),
    workspace: pick('GENAI_WORKSPACE_PORT', defaultPorts.workspace),
    block: pick('GENAI_BLOCK_PORT', defaultPorts.block),
  };
};

const unlessSet = (env: Record<string, string | undefined>, values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([name]) => !env[name]));

/** The platform login in dev (ADR 0061): plain localhost on the portal's port is the login host, each app has `<app>.localhost`. */
export const devPlatformLogin = (
  env: Record<string, string | undefined>,
  ports: ReturnType<typeof devPorts>,
) =>
  unlessSet(env, {
    GENAI_PROXY_KEY: randomBytes(32).toString('base64url'),
    PLATFORM_LOGIN_CLIENT_ID: 'genki-platform-login-local',
    PLATFORM_LOGIN_CLIENT_SECRET: randomBytes(24).toString('base64url'),
    PLATFORM_LOGIN_HOSTNAME: 'localhost',
    PLATFORM_LOGIN_ORIGIN: `http://localhost:${ports.portal}`,
    PLATFORM_APP_ORIGINS: (['portal', 'workspace', 'console'] as const)
      .map((app) => `${app}=http://${app}.localhost:${ports[app]}`)
      .join(','),
  });

export const devProcesses = (env: Record<string, string | undefined>): DevProcess[] => {
  const modelPort = localModelPort(env.LOCAL_MODEL_URL);
  const ports = devPorts(env);
  const login = devPlatformLogin(env, ports);
  const proxyKey = { GENAI_PROXY_KEY: login.GENAI_PROXY_KEY ?? env.GENAI_PROXY_KEY ?? '' };
  const api = `http://localhost:${ports.api}`;
  const custom = ports.api !== defaultPorts.api;
  const devMode = !env.GENAI_DEV_MODE || env.GENAI_DEV_MODE === 'true';
  const apiEnv = {
    ...(devMode ? proxyKey : {}),
    ...(custom
      ? {
          GENAI_API_PORT: String(ports.api),
          ...unlessSet(env, { VITE_PUBLIC_API_BASE: api }),
        }
      : {}),
  };
  return [
    ...(modelPort
      ? [
          {
            name: 'model',
            port: modelPort,
            command: process.execPath,
            args: ['scripts/local-model.ts'],
            env: {
              LOCAL_MODEL_PORT: String(modelPort),
              ...(env.LOCAL_MODEL_RESPONSES
                ? { LOCAL_MODEL_RESPONSES: env.LOCAL_MODEL_RESPONSES }
                : {}),
            },
          },
        ]
      : []),
    {
      name: 'api',
      port: ports.api,
      ...npmCommand(['run', 'dev', '--workspace', 'apps/api']),
      env: {
        ...unlessSet(env, {
          GENAI_DEV_MODE: 'true',
          ...(devMode ? { GENAI_ENV: 'test' } : {}),
          ...(devMode && !env.ANSATTPORTEN_ISSUER ? { GENAI_MOCK_RIGHTS: 'true' } : {}),
          ...(devMode
            ? {
                GENAI_BLOCK_ORIGIN: `http://localhost:${ports.block}`,
                GENAI_BLOCK_PORT: String(ports.block),
              }
            : {}),
        }),
        ...(devMode ? login : {}),
        ...(custom ? { PORT: String(ports.api) } : {}),
      },
    },
    // Runs on the knowledge database are jobs, so a new dataset fills only with the worker (issue 151).
    {
      name: 'worker',
      port: ports.worker,
      ...npmCommand(['run', 'dev', '--workspace', 'apps/worker']),
      env: {
        ...unlessSet(env, { GENAI_DEV_MODE: 'true' }),
        ...(ports.worker === defaultPorts.worker
          ? {}
          : { WORKER_HEALTH_PORT: String(ports.worker) }),
      },
    },
    vite('portal', ports.portal, apiEnv),
    vite('console', ports.console, apiEnv),
    vite('workspace', ports.workspace, {
      ...apiEnv,
      VITE_PORTAL_URL: `http://portal.localhost:${ports.portal}`,
    }),
  ];
};

const colours = [36, 35, 33, 32, 34, 31];

export const prefixer = (label: string, write: (text: string) => void) => {
  let pending = '';
  return {
    push: (chunk: string) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) write(`${label} ${line}\n`);
    },
    flush: () => {
      if (pending) write(`${label} ${pending}\n`);
      pending = '';
    },
  };
};

const answers = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: 500 });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });

export const portInUse = async (port: number) =>
  (await Promise.all(['127.0.0.1', '::1'].map((host) => answers(host, port)))).some(Boolean);

export interface RunOptions {
  cwd: string;
  colour: boolean;
  write: (text: string) => void;
  graceMs?: number;
}

export const runAll = (processes: DevProcess[], options: RunOptions) => {
  const width = Math.max(...processes.map((p) => p.name.length));
  const children: ChildProcess[] = [];
  let stopping = false;
  let finish: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => (finish = resolve));

  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) signal(child, 'SIGTERM');
    const force = setTimeout(
      () => children.forEach((child) => signal(child, 'SIGKILL')),
      options.graceMs ?? 5000,
    );
    force.unref();
    void Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) =>
            child.pid === undefined || child.exitCode !== null || child.signalCode !== null
              ? resolve(undefined)
              : child.once('exit', resolve),
          ),
      ),
    ).then(() => {
      clearTimeout(force);
      finish(code);
    });
  };

  processes.forEach((p, i) => {
    const name = p.name.padEnd(width);
    const label = options.colour
      ? `\x1b[${colours[i % colours.length]}m${name} |\x1b[0m`
      : `${name} |`;
    const child = spawn(p.command, p.args, {
      cwd: options.cwd,
      env: { ...process.env, ...p.env, FORCE_COLOR: options.colour ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // A process group lets stop() signal grandchildren on POSIX. On Windows a detached child
      // gets its own console window instead, and closing that window stops the service.
      detached: process.platform !== 'win32',
    });
    children.push(child);
    for (const stream of [child.stdout, child.stderr]) {
      const out = prefixer(label, options.write);
      stream.setEncoding('utf8');
      stream.on('data', out.push);
      stream.on('end', out.flush);
    }
    // A command that cannot start emits error and never exit, so stop the rest here.
    child.on('error', (error) => {
      if (stopping) return;
      // Plain npm is only used outside an npm script, where Windows cannot spawn it.
      const hint = p.command === 'npm' ? '; start it with `npm run dev:all`' : '';
      options.write(`${label} could not start (${error.message}${hint}), stopping the rest\n`);
      stop(1);
    });
    child.on('exit', (code, sig) => {
      if (stopping) return;
      options.write(`${label} stopped (${sig ?? `exit ${code}`}), stopping the rest\n`);
      stop(code || 1);
    });
  });

  return { stop, exited, pids: () => children.map((c) => c.pid) };
};

const main = async () => {
  const envFile = join(repoRoot, '.env.local');
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  if (!existsSync(envFile)) console.warn('No .env.local: run `npm run setup` first.');
  const processes = devProcesses({ ...fileEnv, ...process.env });

  const busy: string[] = [];
  for (const p of processes) if (await portInUse(p.port)) busy.push(`${p.name} :${p.port}`);
  const blockPort = Number(processes.find((p) => p.name === 'api')?.env?.GENAI_BLOCK_PORT);
  if (blockPort && (await portInUse(blockPort))) busy.push(`blocks :${blockPort}`);
  if (busy.length) {
    console.error(`Ports already in use: ${busy.join(', ')}. Stop what runs there and try again.`);
    process.exit(1);
  }

  const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const run = runAll(processes, { cwd: repoRoot, colour, write: (t) => process.stdout.write(t) });
  const ports = devPorts({ ...fileEnv, ...process.env });
  console.log(
    `API http://localhost:${ports.api}  portal http://portal.localhost:${ports.portal}  console http://console.localhost:${ports.console}  workspace http://workspace.localhost:${ports.workspace}  blocks http://localhost:${ports.block}  (Ctrl-C stops all)`,
  );
  process.on('SIGINT', () => run.stop(0));
  process.on('SIGTERM', () => run.stop(0));
  process.exit(await run.exited);
};

const signal = (child: ChildProcess, sig: NodeJS.Signals) => {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  // Windows has no process groups: kill the tree, or the servers npm started keep their ports.
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
      'error',
      () => child.kill(sig),
    );
    return;
  }
  try {
    process.kill(-child.pid, sig);
  } catch {
    child.kill(sig);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
