import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { parse as parseYaml } from 'yaml';
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

export const defaultPorts = { api: 8080, portal: 5173, console: 5174, workspace: 5176 };

export const devPorts = (env: Record<string, string | undefined>) => {
  const pick = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    api: pick('GENAI_API_PORT', defaultPorts.api),
    portal: pick('GENAI_PORTAL_PORT', defaultPorts.portal),
    console: pick('GENAI_CONSOLE_PORT', defaultPorts.console),
    workspace: pick('GENAI_WORKSPACE_PORT', defaultPorts.workspace),
  };
};

const unlessSet = (env: Record<string, string | undefined>, values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([name]) => !env[name]));

export const devProcesses = (env: Record<string, string | undefined>): DevProcess[] => {
  const modelPort = localModelPort(env.LOCAL_MODEL_URL);
  const ports = devPorts(env);
  const api = `http://localhost:${ports.api}`;
  const custom = ports.api !== defaultPorts.api;
  const apiEnv = custom
    ? {
        GENAI_API_PORT: String(ports.api),
        ...unlessSet(env, {
          VITE_PUBLIC_API_BASE: api,
          VITE_ANSATTPORTEN_ISSUER: `${api}/mock/ansattporten`,
          VITE_OIDC_ISSUER: `${api}/mock/ansattporten`,
        }),
      }
    : {};
  return [
    ...(modelPort
      ? [
          {
            name: 'model',
            port: modelPort,
            command: process.execPath,
            args: ['scripts/local-model.ts'],
            env: { LOCAL_MODEL_PORT: String(modelPort) },
          },
        ]
      : []),
    {
      name: 'api',
      port: ports.api,
      ...npmCommand(['run', 'dev', '--workspace', 'apps/api']),
      env: {
        ...unlessSet(env, { GENAI_DEV_MODE: 'true' }),
        ...(custom ? { PORT: String(ports.api) } : {}),
      },
    },
    vite('portal', ports.portal, apiEnv),
    vite('console', ports.console, apiEnv),
    vite('workspace', ports.workspace, {
      ...apiEnv,
      VITE_PORTAL_URL: `http://localhost:${ports.portal}`,
    }),
  ];
};

export const missingCallbacks = (identityYaml: string, processes: DevProcess[]): string[] => {
  const clients =
    (parseYaml(identityYaml) as { clients?: { clientId: string; redirectUris?: string[] }[] })
      ?.clients ?? [];
  return processes.flatMap((p) => {
    const client = clients.find((c) => c.clientId === `local-${p.name}`);
    const callback = `http://localhost:${p.port}/callback`;
    return client && !client.redirectUris?.includes(callback)
      ? [`${client.clientId} ${callback}`]
      : [];
  });
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
  if (busy.length) {
    console.error(`Ports already in use: ${busy.join(', ')}. Stop what runs there and try again.`);
    process.exit(1);
  }

  const identity = join(repoRoot, 'apps/api/config/local/identity.yaml');
  const unregistered = existsSync(identity)
    ? missingCallbacks(readFileSync(identity, 'utf8'), processes)
    : [];
  if (unregistered.length)
    console.warn(
      `Login will fail: add these callbacks to the clients in apps/api/config/local/identity.yaml: ${unregistered.join(', ')}`,
    );

  const colour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const run = runAll(processes, { cwd: repoRoot, colour, write: (t) => process.stdout.write(t) });
  const ports = devPorts({ ...fileEnv, ...process.env });
  console.log(
    `API http://localhost:${ports.api}  portal http://localhost:${ports.portal}  console http://localhost:${ports.console}  workspace http://localhost:${ports.workspace}  (Ctrl-C stops all)`,
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
