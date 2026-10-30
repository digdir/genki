import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export const repoRoot = join(import.meta.dirname, '..');
export const localPorts = (env: Record<string, string | undefined> = process.env) => ({
  postgres: Number(env.GENAI_POSTGRES_PORT) || 55432,
  knowledge: Number(env.GENAI_KNOWLEDGE_PORT) || 55433,
  model: Number(env.GENAI_MODEL_PORT) || 8095,
});
export const databaseUrlFor = (port: number) =>
  `postgres://genai:genai-local-only@127.0.0.1:${port}/genai`;
export const knowledgeUrlFor = (port: number) => `postgres://127.0.0.1:${port}/genai_knowledge`;
export const knowledgeAdminUrlFor = (port: number) =>
  `postgres://genai:genai-local-only@127.0.0.1:${port}/genai_knowledge`;
export const modelUrlFor = (port: number) => `http://127.0.0.1:${port}/v1`;
export const localDatabaseUrl = databaseUrlFor(55432);
export const localModelUrl = modelUrlFor(8095);

export const knowledgeSettings = (
  random: (size: number) => Buffer = randomBytes,
  env: Record<string, string | undefined> = process.env,
) => ({
  KNOWLEDGE_DATABASE_URL: knowledgeUrlFor(localPorts(env).knowledge),
  KNOWLEDGE_API_PASSWORD: random(24).toString('base64url'),
  KNOWLEDGE_WORKER_PASSWORD: random(24).toString('base64url'),
});

export const generatedSettings = (
  random: (size: number) => Buffer = randomBytes,
  env: Record<string, string | undefined> = process.env,
) => ({
  ...knowledgeSettings(random, env),
  GENAI_DEV_MODE: 'true',
  DATABASE_URL: databaseUrlFor(localPorts(env).postgres),
  CONTENT_MASTER_KEY: random(32).toString('base64'),
  DEV_API_KEY: `dev-${random(24).toString('base64url')}`,
  DEV_SERVICE_API_KEY: `dev-service-${random(24).toString('base64url')}`,
  LOCAL_MODEL_URL: modelUrlFor(localPorts(env).model),
  LOCAL_MODEL_KEY: 'local-only',
});

export const fillEnv = (template: string, values: Record<string, string>): string => {
  let text = template;
  const missing: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    const line = new RegExp(`^(?:# ?)?${name}=.*$`, 'm');
    if (line.test(text)) text = text.replace(line, () => `${name}=${value}`);
    else missing.push(`${name}=${value}`);
  }
  return missing.length ? `${text.replace(/\n*$/, '\n')}${missing.join('\n')}\n` : text;
};

export interface EnvResult {
  path: string;
  created: boolean;
  missing: string[];
  added?: string[];
}

export const ensureEnvFile = (
  root: string,
  random: (size: number) => Buffer = randomBytes,
  env: Record<string, string | undefined> = process.env,
): EnvResult => {
  const path = join(root, '.env.local');
  const values = generatedSettings(random, env);
  const template = readFileSync(join(root, '.env.example'), 'utf8');
  try {
    writeFileSync(path, fillEnv(template, values), { mode: 0o600, flag: 'wx' });
    return { path, created: true, missing: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const text = readFileSync(path, 'utf8');
  const current = parseEnv(text);
  const knowledge = Object.entries(knowledgeSettings(random, env)).filter(
    ([name]) => !(name in current),
  );
  if (knowledge.length)
    writeFileSync(
      path,
      `${text.replace(/\n*$/, '\n')}${knowledge.map(([name, value]) => `${name}=${value}`).join('\n')}\n`,
    );
  const added = new Set(knowledge.map(([name]) => name));
  const missing = Object.keys(values).filter((name) => !current[name] && !added.has(name));
  return { path, created: false, missing, ...(added.size ? { added: [...added] } : {}) };
};

export const nodeProblem = (version: string, pinned: string | undefined): string | undefined => {
  const major = Number(version.split('.')[0]);
  if (major < 24)
    return `Node ${version} is too old. Run \`mise install\` and use Node ${pinned ?? 24}.`;
  if (pinned && version !== pinned)
    return `Node ${version} runs, the repo pins ${pinned}. \`mise install\` gives you the pinned one.`;
  return undefined;
};

const pinnedNode = (root: string) => {
  const mise = join(root, 'mise.toml');
  if (!existsSync(mise)) return undefined;
  return /^node\s*=\s*"([^"]+)"/m.exec(readFileSync(mise, 'utf8'))?.[1];
};

const run = (command: string, args: string[], cwd: string, quiet = false) =>
  spawnSync(command, args, { cwd, stdio: quiet ? 'ignore' : 'inherit' }).status === 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startPostgres = async (root: string) => {
  if (!run('docker', ['info'], root, true)) {
    console.error(
      'Docker is not running. Start Docker Desktop (or the docker daemon) and run again.',
    );
    return false;
  }
  if (!run('docker', ['compose', 'up', '-d', 'postgres', 'knowledge'], root)) return false;
  for (const [service, database] of [
    ['postgres', 'genai'],
    ['knowledge', 'genai_knowledge'],
  ] as const) {
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt++) {
      ready = run(
        'docker',
        ['compose', 'exec', '-T', service, 'pg_isready', '-U', 'genai', '-d', database],
        root,
        true,
      );
      if (!ready) await sleep(1000);
    }
    if (!ready) {
      console.error(
        `Postgres did not become ready within 60 seconds: docker compose logs ${service}`,
      );
      return false;
    }
  }
  return true;
};

const main = async () => {
  const args = process.argv.slice(2);
  const rootFlag = args.indexOf('--root');
  const root = (rootFlag >= 0 ? args[rootFlag + 1] : undefined) ?? repoRoot;
  const skipDocker = args.includes('--skip-docker');

  const problem = nodeProblem(process.versions.node, pinnedNode(root));
  if (problem) console.warn(problem);
  if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1);

  if (!existsSync(join(root, 'node_modules'))) {
    console.log('Installing dependencies');
    if (!run('npm', ['install'], root)) process.exit(1);
  }

  if (!skipDocker) {
    console.log(
      `Starting Postgres (pgvector) on 127.0.0.1:${localPorts().postgres} and the knowledge server on 127.0.0.1:${localPorts().knowledge}, compose project ${process.env.COMPOSE_PROJECT_NAME ?? 'named after this folder'}`,
    );
    if (!(await startPostgres(root))) process.exit(1);
    console.log('Postgres is ready');
  }

  const env = ensureEnvFile(root);
  if (env.created) console.log(`Created ${env.path} with a local database and generated keys`);
  else if (env.missing.length)
    console.log(`Kept ${env.path}. Not set there: ${env.missing.join(', ')} (see .env.example)`);
  else console.log(`Kept ${env.path}`);
  if (env.added) console.log(`Added to ${env.path}: ${env.added.join(', ')}`);

  if (!skipDocker) {
    console.log('Setting up the knowledge server: roles, the API and worker logins, the binding');
    if (!run('npm', ['run', 'knowledge:setup', '--', '--local'], root)) process.exit(1);
  }

  console.log(`
Next:
  npm run dev:all     API :8080, portal :5173, console :5174, workspace :5176 (see docs/development.md for other ports)
  npm run check       format, lint, types, boundaries and tests (needs Docker)

Log in as a test person from apps/api/config/local/identity.yaml (Kari Testansatt has every right).
Without Foundry settings, chat with "Lokal testchat" in the workspace: it echoes what you write.
Your API keys for local clients are DEV_API_KEY and DEV_SERVICE_API_KEY in .env.local.`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
