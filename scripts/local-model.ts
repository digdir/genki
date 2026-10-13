import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

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

const readBody = async (req: IncomingMessage): Promise<ChatBody> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as ChatBody;
  } catch {
    return {};
  }
};

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
  if (req.method === 'GET' && path.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'echo', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
    return;
  }
  const body = await readBody(req);
  const content = localCompletion(body);
  const id = `chatcmpl-local-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'echo';
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: usage(body, content),
      }),
    );
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

export const startLocalModel = (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handle(req, res).catch((error: unknown) => {
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
