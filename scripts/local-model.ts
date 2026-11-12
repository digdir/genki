import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: { role: string; content?: unknown }[];
  response_format?: { type?: string; json_schema?: { schema?: JsonSchema } };
}

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part: { text?: unknown }) => (typeof part.text === 'string' ? part.text : ''))
          .join(' ')
      : '';

export const localReply = (body: ChatBody): string => {
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  const said = textOf(last?.content)
    .split(/\n\n\{/)[0]
    ?.trim()
    .slice(0, 500);
  return `Lokal testmodell, ingen ekte KI. Du skrev: ${said || '(ingenting)'}`;
};

const valueFor = (schema: JsonSchema | undefined, text: string): unknown => {
  if (schema?.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (type === 'object')
    return Object.fromEntries(
      Object.entries(schema?.properties ?? {}).map(([k, v]) => [k, valueFor(v, text)]),
    );
  if (type === 'array') return [];
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  return text;
};

export const localCompletion = (body: ChatBody): string => {
  const text = localReply(body);
  const schema = body.response_format?.json_schema?.schema;
  return body.response_format?.type === 'json_schema' && schema
    ? JSON.stringify(valueFor(schema, text))
    : text;
};

const usage = (body: ChatBody, content: string) => {
  const prompt = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  const completion = Math.ceil(content.length / 4);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
};

const readBody = async <T>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
  } catch {
    return {} as T;
  }
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export const responseFolders = (env: NodeJS.ProcessEnv): string[] =>
  (env.LOCAL_MODEL_RESPONSES ?? '').split(delimiter).filter(Boolean);

interface ResponseFile {
  file: string;
  deployment?: string;
  request: { method: string; path: string; body?: unknown };
  response: { status?: number; headers?: Record<string, string>; body: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isResponseFile = (value: unknown): value is Omit<ResponseFile, 'file'> =>
  isRecord(value) &&
  isRecord(value.request) &&
  typeof value.request.method === 'string' &&
  typeof value.request.path === 'string' &&
  isRecord(value.response) &&
  'body' in value.response;

const parseFile = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

export const readResponseFiles = (folders: string[]): ResponseFile[] =>
  folders
    .filter((folder) => existsSync(folder))
    .flatMap((folder) =>
      readdirSync(folder)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({ name, file: join(folder, name) })),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(({ file }) => {
      const parsed = parseFile(file);
      if (isResponseFile(parsed)) return [{ ...parsed, file }];
      console.warn(
        JSON.stringify({ msg: 'local test model skips a file that is not a response file', file }),
      );
      return [];
    });

const withoutV1 = (path: string) => path.replace(/\/+$/, '').replace(/^\/v1(?=\/|$)/, '') || '/';

const contains = (expected: unknown, actual: unknown): boolean =>
  isRecord(expected)
    ? isRecord(actual) && Object.entries(expected).every(([k, v]) => contains(v, actual[k]))
    : isDeepStrictEqual(expected, actual);

const subsetKeys = (expected: unknown, body: unknown) => {
  if (expected === undefined || expected === null) return [0];
  if (!contains(expected, body)) return [-1];
  return [isRecord(expected) ? Object.keys(expected).length : 1];
};

const samePathKeys = (expected: unknown, body: unknown) => {
  if (!isRecord(expected) || !isRecord(body)) return [0, 0];
  const sameModel = 'model' in expected && isDeepStrictEqual(expected.model, body.model) ? 1 : 0;
  const keys = Object.entries(expected).filter(([k, v]) => contains(v, body[k])).length;
  return [sameModel, keys];
};

const higher = (a: number[], b: number[]) => {
  const i = a.findIndex((v, n) => v !== b[n]);
  return i >= 0 && (a[i] ?? 0) > (b[i] ?? 0);
};

const best = (
  files: ResponseFile[],
  method: string,
  path: string,
  score: (expected: unknown) => number[],
) => {
  let found: ResponseFile | undefined;
  let foundScore: number[] = [];
  for (const file of files) {
    if (file.request.method.toUpperCase() !== method || withoutV1(file.request.path) !== path)
      continue;
    const fileScore = score(file.request.body);
    if (fileScore[0] === -1) continue;
    if (!found || higher(fileScore, foundScore)) [found, foundScore] = [file, fileScore];
  }
  return found;
};

export const bestResponse = (
  files: ResponseFile[],
  method: string,
  path: string,
  body: unknown,
): ResponseFile | undefined => {
  const [m, p] = [method.toUpperCase(), withoutV1(path)];
  return (
    best(files, m, p, (expected) => subsetKeys(expected, body)) ??
    best(files, m, p, (expected) => samePathKeys(expected, body))
  );
};

const deploymentOf = (file: ResponseFile) =>
  file.deployment ?? (isRecord(file.request.body) ? file.request.body.model : undefined);

const replay = (res: ServerResponse, { response }: ResponseFile) => {
  const headers = { 'content-type': 'application/json', ...response.headers };
  const raw = typeof response.body === 'string' && !/json/i.test(headers['content-type']);
  res.writeHead(response.status ?? 200, headers);
  res.end(raw ? response.body : JSON.stringify(response.body));
};

const echo = (res: ServerResponse, body: ChatBody) => {
  const created = Math.floor(Date.now() / 1000);
  const content = localCompletion(body);
  const id = `chatcmpl-local-${Date.now()}`;
  const model = body.model ?? 'echo';
  if (!body.stream) {
    json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: usage(body, content),
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  chunk({ role: 'assistant', content: '' });
  for (const piece of content.match(/\S+\s*/g) ?? [content]) chunk({ content: piece });
  chunk({}, 'stop');
  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: usage(body, content),
  });
  res.end('data: [DONE]\n\n');
};

const handle = async (req: IncomingMessage, res: ServerResponse, folders: string[]) => {
  const method = (req.method ?? 'GET').toUpperCase();
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  const files = readResponseFiles(folders);
  if (method === 'GET' && withoutV1(path) === '/models') {
    const ids = [...new Set(['echo', 'replay', ...files.map(deploymentOf)])].filter(
      (id): id is string => typeof id === 'string',
    );
    json(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    return;
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody<unknown>(req);
  const file = bestResponse(files, method, path, body);
  if (file) {
    replay(res, file);
    return;
  }
  if (method === 'POST' && withoutV1(path) === '/chat/completions') {
    echo(res, body as ChatBody);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/problem+json' });
  res.end(
    JSON.stringify({
      type: 'about:blank',
      title: 'No local response',
      status: 404,
      detail: `The local test model has no response file for ${method} ${path}. Put one in ${folders.length ? folders.join(' or ') : 'a folder named by LOCAL_MODEL_RESPONSES'}.`,
    }),
  );
};

export const startLocalModel = (
  port: number,
  folders = responseFolders(process.env),
): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res, folders).catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      });
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.LOCAL_MODEL_PORT ?? 8095);
  await startLocalModel(port);
  console.log(JSON.stringify({ msg: 'local test model listening', port }));
}
