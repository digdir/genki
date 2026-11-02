// Makes a project on the local Langfuse (docs/development.md). Only node: imports, since walks run it
// read from origin/main into another folder.
import { readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';

const host = process.env.LANGFUSE_LOCAL_URL ?? 'http://localhost:34620';
const user = { email: 'genki@example.com', password: 'genki-local-only' };
const llmProvider = 'foundry-claude';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    judge: { type: 'string', multiple: true, default: [] },
    'llm-from': { type: 'string' },
    model: { type: 'string', default: 'claude-sonnet-5' },
    delete: { type: 'boolean', default: false },
  },
});
const [name] = positionals;
if (!name) {
  console.error(
    'Usage: node scripts/langfuse-seed.ts <project> [--judge <name>]... [--llm-from <env file>] [--model <id>] [--delete]',
  );
  process.exit(1);
}

let foundry: { key: string; baseURL: string } | undefined;
if (values['llm-from']) {
  const env = parseEnv(readFileSync(values['llm-from'], 'utf8'));
  const { FOUNDRY_CLAUDE_KEY: key, FOUNDRY_CLAUDE_BASE_URL: baseURL } = env;
  if (!key || !baseURL)
    throw new Error(`${values['llm-from']} has no FOUNDRY_CLAUDE_KEY and FOUNDRY_CLAUDE_BASE_URL`);
  foundry = { key, baseURL: baseURL.replace(/\/+$/, '') };
}

const fail = async (what: string, response: Response): Promise<never> => {
  throw new Error(`${what}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
};

let cookies: string[] = [];
const keep = (response: Response) => {
  const set = response.headers.getSetCookie().map((c) => c.split(';')[0] ?? '');
  const names = new Set(set.map((c) => c.split('=')[0]));
  cookies = [...cookies.filter((c) => !names.has(c.split('=')[0])), ...set];
};
const browser = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(new URL(path, host), {
    ...init,
    redirect: 'manual',
    headers: { ...init.headers, cookie: cookies.join('; ') },
  });
  keep(response);
  return response;
};
// Without a licence the public API makes no projects (403), so these are the routes Langfuse's UI calls.
const trpc = async <T>(route: string, input: unknown): Promise<T> => {
  const response = await browser(`/api/trpc/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });
  if (!response.ok) await fail(route, response);
  return ((await response.json()) as { result: { data: { json: T } } }).result.data.json;
};

const csrf = await browser('/api/auth/csrf').catch(() => {
  console.error(`No Langfuse answers at ${host}: npm run langfuse starts it.`);
  process.exit(1);
});
if (!csrf.ok) await fail(`Langfuse at ${host}`, csrf);
const { csrfToken } = (await csrf.json()) as { csrfToken: string };
await browser('/api/auth/callback/credentials', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ csrfToken, ...user, json: 'true' }),
});
const session = (await (await browser('/api/auth/session')).json()) as {
  user?: { organizations: { id: string; projects: { id: string; name: string }[] }[] };
};
const [org] = session.user?.organizations ?? [];
if (!org) throw new Error(`could not log in to ${host} as ${user.email}`);

const old = org.projects.find((p) => p.name === name);
if (old) await trpc('projects.delete', { projectId: old.id });
if (values.delete) {
  console.log(JSON.stringify({ host, deleted: old ? { id: old.id, name } : null }, null, 2));
  process.exit(0);
}

const project = await trpc<{ id: string }>('projects.create', { name, orgId: org.id });
const keys = await trpc<{ publicKey: string; secretKey: string }>('projectApiKeys.create', {
  projectId: project.id,
  note: 'scripts/langfuse-seed.ts',
});
const api = async <T>(method: string, path: string, body: unknown): Promise<T> => {
  const response = await fetch(new URL(path, host), {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${keys.publicKey}:${keys.secretKey}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) await fail(`${method} ${path}`, response);
  return (await response.json()) as T;
};

let llmConnection: string | undefined;
if (foundry) {
  const connection = await api<{ id: string }>('PUT', '/api/public/llm-connections', {
    provider: llmProvider,
    adapter: 'anthropic',
    secretKey: foundry.key,
    baseURL: foundry.baseURL,
    customModels: [values.model],
    withDefaultModels: false,
  });
  llmConnection = connection.id;
}

// Each judge scores each case of a test run once, on the root span of its experiment item.
const judges = [];
for (const judge of values.judge) {
  const evaluator = await api<{ id: string; status: string; pausedMessage?: string | null }>(
    'POST',
    '/api/public/v2/evaluators',
    {
      name: judge,
      type: 'llm_as_judge',
      prompt: 'Vurder om svaret svarer på spørsmålet.\n\nSpørsmål:\n{{input}}\n\nSvar:\n{{output}}',
      modelConfig: llmConnection ? { provider: llmProvider, model: values.model } : null,
      variableMapping: [
        { variable: 'input', source: 'input' },
        { variable: 'output', source: 'output' },
      ],
      outputDefinition: {
        dataType: 'BOOLEAN',
        scoreReasoningInstructions: 'Én setning om hvorfor.',
        scoreValueInstructions: 'true når svaret svarer på spørsmålet, ellers false.',
      },
    },
  );
  const rule = await api<{ id: string }>('POST', '/api/public/v2/evaluation-rules', {
    name: judge,
    enabled: true,
    sampling: 1,
    filter: [{ type: 'boolean', column: 'isExperimentItemRootSpan', operator: '=', value: true }],
    evaluatorAssignments: [{ evaluatorId: evaluator.id, variableMapping: null }],
  });
  judges.push({
    name: judge,
    evaluator: evaluator.id,
    rule: rule.id,
    status: evaluator.status,
    ...(evaluator.pausedMessage ? { paused: evaluator.pausedMessage } : {}),
  });
}

console.log(
  JSON.stringify(
    {
      host,
      project: { id: project.id, name },
      publicKey: keys.publicKey,
      secretKey: keys.secretKey,
      ...(llmConnection ? { llmConnection, model: values.model } : {}),
      judges,
    },
    null,
    2,
  ),
);
