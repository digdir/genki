import { Hono, type Context } from 'hono';
import {
  checkInputFields,
  fieldsQuery,
  type Input,
  type InputValue,
  type Part,
  type Principal,
  type Task,
} from '@genai/contracts';
import { KernelError, type Kernel, type Run } from '@genai/kernel';
import {
  a2aVersion,
  acceptsOutput,
  agentCard,
  agentMessage,
  answerArtifact,
  errorCodes,
  publicAgentCard,
  rpcError,
  rpcResult,
  terminal,
  toA2aTask,
  type A2aMessage,
  type A2aPart,
  type A2aTask,
  type AgentEntry,
  type JsonRpcId,
  type TaskState,
} from './protocol.js';
import { fromLegacyParams, legacyMethods, legacyVersion, toLegacyResult } from './legacy.js';
import { pageOf, readListQuery } from './list-tasks.js';

export type AgentResolution =
  { ok: true; entry: AgentEntry } | { ok: false; code: string; message: string };

export interface AgentResolver {
  list(principal: Principal): Promise<AgentEntry[]>;
  resolve(principal: Principal, name: string): Promise<AgentResolution>;
}

export interface Authenticator {
  authenticate(request: Request): Promise<Principal | undefined>;
}

export interface PublicAgent {
  entry: AgentEntry;
  provider?: { organization: string; url?: string };
}

export interface PublicDiscovery {
  list(): Promise<PublicAgent[]>;
  resolve(name: string): Promise<PublicAgent | undefined>;
  limit(c: Context): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>;
}

export interface History {
  role: string;
  text: string;
}

export interface A2aAppOptions {
  kernel: Kernel;
  resolver: AgentResolver;
  auth: Authenticator;
  exposed?: (entry: AgentEntry) => boolean | Promise<boolean>;
  publicDiscovery?: PublicDiscovery;
  path?: string;
  baseUrl?: (request: Request) => string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  modelsOf?: (task: string) => Promise<string[]>;
  taskIds?: (principal: Principal) => Promise<string[]>;
  history?: (principal: Principal, contextId: string) => Promise<History[]>;
  contextId?: () => string;
  maxBodyBytes?: number;
  heartbeatMs?: number;
  cancelWaitMs?: number;
}

type RpcBody = ReturnType<typeof rpcResult> | ReturnType<typeof rpcError>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const pinned = /@\d+$/;
const sameCapability = (a: string, b: string) => a.replace(pinned, '') === b.replace(pinned, '');

const supportedVersion = (raw: string | undefined) => {
  const value = raw?.trim();
  if (!value) return true;
  return value === a2aVersion || value === '1' || value === legacyVersion;
};

const legacyDialect = 'a2aLegacy' as never;
const isLegacy = (c: Context) => c.get(legacyDialect) === true;
const dialectOf = (c: Context, body: RpcBody): RpcBody =>
  isLegacy(c) && 'result' in body ? { ...body, result: toLegacyResult(body.result) } : body;

interface ReadMessage {
  message: A2aMessage;
  text: string;
  data: Record<string, unknown>;
}

const readMessage = (params: Record<string, unknown>): ReadMessage | { error: string } => {
  const m = params.message;
  if (!isRecord(m)) return { error: '`message` is required.' };
  if (typeof m.messageId !== 'string' || m.messageId === '')
    return { error: '`message.messageId` is required.' };
  if (m.role !== 'ROLE_USER') return { error: '`message.role` must be ROLE_USER.' };
  if (!Array.isArray(m.parts) || m.parts.length === 0)
    return { error: '`message.parts` must have at least one part.' };
  const texts: string[] = [];
  const data: Record<string, unknown> = {};
  for (const part of m.parts as unknown[]) {
    if (!isRecord(part)) return { error: 'each part must be an object.' };
    if (typeof part.text === 'string') texts.push(part.text);
    else if (isRecord(part.data)) Object.assign(data, part.data);
    else if (part.raw !== undefined || part.url !== undefined) return { error: 'content_type' };
    else if (part.data === undefined) return { error: 'each part needs text, data, raw or url.' };
  }
  return { message: m as unknown as A2aMessage, text: texts.join('\n'), data };
};

export const createA2aApp = (options: A2aAppOptions) => {
  const { kernel, resolver, auth } = options;
  const path = options.path ?? '/a2a';
  const maxBody = options.maxBodyBytes ?? 1_048_576;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const cancelWaitMs = options.cancelWaitMs ?? 2_000;
  const newContext = options.contextId ?? (() => crypto.randomUUID());
  const baseOf = (request: Request) =>
    (options.baseUrl?.(request) ?? new URL(request.url).origin).replace(/\/$/, '');
  const urlOf = (request: Request, id: string) =>
    `${baseOf(request)}${path}/${encodeURIComponent(id)}`;
  const cardOf = (request: Request, entry: AgentEntry) =>
    agentCard(entry, {
      url: urlOf(request, entry.id),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.documentationUrl ? { documentationUrl: options.documentationUrl } : {}),
    });
  const isExposed = async (entry: AgentEntry) => (options.exposed ? options.exposed(entry) : true);
  const modelsOf = async (task: string) => {
    try {
      return (await options.modelsOf?.(task)) ?? [];
    } catch {
      return [];
    }
  };

  const agents = async (principal: Principal) => {
    const seen = new Set<string>();
    const out: AgentEntry[] = [];
    for (const entry of await resolver.list(principal)) {
      if (seen.has(entry.capability)) continue;
      seen.add(entry.capability);
      if (await isExposed(entry)) out.push(entry);
    }
    return out;
  };

  const agentFor = async (principal: Principal, name: string) => {
    const resolved = await resolver.resolve(principal, name);
    if (!resolved.ok) return resolved;
    if (!(await isExposed(resolved.entry)))
      return { ok: false as const, code: 'agent_not_found', message: `Agent not found: ${name}` };
    return resolved;
  };

  const metadataFor = async (entry: AgentEntry, task: string) => {
    const models = await modelsOf(task);
    return {
      models,
      metadata: {
        aiGenerated: true,
        service: entry.id,
        ...(models.length === 1 ? { model: models[0] } : {}),
        ...(entry.version === undefined ? {} : { serviceVersion: entry.version }),
      },
    };
  };

  const aiHeaders = (task: string, models: string[], entry: AgentEntry) => ({
    'genai-generated-by': 'ai',
    'genai-task': task,
    ...(models.length === 1 && models[0] ? { 'genai-model': models[0] } : {}),
    ...(entry.version === undefined ? {} : { 'genai-service-version': String(entry.version) }),
  });

  const json = (c: Context, body: RpcBody, status = 200, headers: Record<string, string> = {}) =>
    c.body(JSON.stringify(dialectOf(c, body)), status as 200, {
      'Content-Type': 'application/json',
      'A2A-Version': isLegacy(c) ? legacyVersion : a2aVersion,
      ...headers,
    });

  type Settled =
    | { status: 'completed'; parts: Part[] }
    | { status: 'interrupted' | 'cancelled'; message?: string }
    | { status: 'failed'; message: string; code: string };

  const settle = async (run: Run): Promise<Settled> => {
    try {
      return { status: 'completed', parts: await run.result };
    } catch (error) {
      if (error instanceof KernelError && error.code === 'interrupted')
        return { status: 'interrupted' };
      if (error instanceof KernelError && error.code === 'cancelled')
        return { status: 'cancelled', message: error.message };
      return {
        status: 'failed',
        code: error instanceof KernelError ? error.code : 'strategy_error',
        message: error instanceof KernelError ? error.message : 'the service failed',
      };
    }
  };

  const finalTask = async (
    principal: Principal,
    run: Run,
    settled: Settled,
    contextId: string,
    metadata: Record<string, unknown>,
  ): Promise<A2aTask> => {
    if (settled.status === 'completed')
      return {
        id: run.task,
        contextId,
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
        artifacts: [answerArtifact(run.task, settled.parts)],
        metadata,
      };
    if (settled.status === 'interrupted') {
      const stored = await kernel.task(principal, run.task);
      return { ...toA2aTask(stored), contextId, metadata };
    }
    return {
      id: run.task,
      contextId,
      status: {
        state: settled.status === 'cancelled' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED',
        timestamp: new Date().toISOString(),
        ...(settled.message ? { message: agentMessage(settled.message, run.task, contextId) } : {}),
      },
      metadata: {
        ...metadata,
        ...(settled.status === 'failed' ? { errorCode: settled.code } : {}),
      },
    };
  };

  const loadTask = async (
    principal: Principal,
    entry: AgentEntry,
    id: unknown,
  ): Promise<Task | undefined> => {
    if (typeof id !== 'string' || id === '') return undefined;
    try {
      const task = await kernel.task(principal, id);
      return sameCapability(task.service.capability.id, entry.capability) ? task : undefined;
    } catch (error) {
      if (error instanceof KernelError && error.code === 'not_found') return undefined;
      throw error;
    }
  };

  type Started =
    { run: Run; contextId: string; read: ReadMessage } | { error: RpcBody; status?: number };

  const start = async (
    id: JsonRpcId,
    principal: Principal,
    entry: AgentEntry,
    params: Record<string, unknown>,
  ): Promise<Started> => {
    const configuration = isRecord(params.configuration) ? params.configuration : {};
    if (!acceptsOutput(configuration.acceptedOutputModes))
      return {
        error: rpcError(
          id,
          errorCodes.contentType,
          'None of the accepted output modes is produced.',
        ),
      };
    const read = readMessage(params);
    if ('error' in read)
      return read.error === 'content_type'
        ? {
            error: rpcError(
              id,
              errorCodes.contentType,
              'File parts are not supported; send text or data parts.',
            ),
          }
        : { error: rpcError(id, errorCodes.invalidParams, read.error) };
    const { message, text, data } = read;

    if (message.taskId) {
      const task = await loadTask(principal, entry, message.taskId);
      if (!task) return { error: rpcError(id, errorCodes.taskNotFound, 'Task not found') };
      if (task.status !== 'interrupted' || !task.pendingInterrupt)
        return {
          error: rpcError(
            id,
            errorCodes.unsupported,
            terminal(task.status)
              ? 'The task has ended; start a new task without taskId.'
              : 'The task is still working; it does not take input now.',
          ),
        };
      const response: Input = {
        ...(text ? { parts: [{ mime: 'text/plain', body: { kind: 'text', text } }] } : {}),
        data: Object.keys(data).length > 0 ? data : { text },
      };
      try {
        const run = await kernel.resume(principal, task.id, task.pendingInterrupt.id, response);
        return { run, contextId: task.thread ?? message.contextId ?? newContext(), read };
      } catch (error) {
        if (error instanceof KernelError)
          return {
            error: rpcError(id, errorCodes.unsupported, error.message, { code: error.code }),
          };
        throw error;
      }
    }

    let query = text.trim() || undefined;
    let values: Record<string, InputValue> = {};
    const fields = entry.inputFields;
    if (fields?.length) {
      const checked = checkInputFields(fields, data);
      if (!checked.ok)
        return {
          error: rpcError(
            id,
            errorCodes.invalidParams,
            checked.errors.map((e) => e.message).join(' '),
            { code: 'invalid_input', errors: checked.errors },
          ),
        };
      values = checked.values;
      query = fieldsQuery(fields, values, query) || undefined;
    }
    if (!query)
      return {
        error: rpcError(id, errorCodes.invalidParams, 'The message needs a text part.', {
          code: 'missing_query',
        }),
      };
    const contextId = message.contextId || newContext();
    const history = message.contextId
      ? ((await options.history?.(principal, contextId).catch(() => [])) ?? [])
      : [];
    const input: Input = {
      parts: [
        {
          mime: 'text/plain',
          body: { kind: 'text', text: query },
          ...(fields?.length ? { meta: { inputFields: true } } : {}),
        },
      ],
      data: { ...data, ...values, query, history },
    };
    try {
      const run = await kernel.invoke(principal, entry.capability, input, {
        thread: contextId,
        entryPoint: 'a2a',
      });
      return { run, contextId, read };
    } catch (error) {
      if (error instanceof KernelError)
        return {
          error: rpcError(id, errorCodes.internal, error.message, { code: error.code }),
          status: error.code === 'forbidden' ? 403 : 200,
        };
      throw error;
    }
  };

  const userHistory = (read: ReadMessage, task: string, contextId: string, length: unknown) =>
    length === 0 ? {} : { history: [{ ...read.message, taskId: task, contextId }] };

  const sendMessage = async (
    c: Context,
    id: JsonRpcId,
    principal: Principal,
    entry: AgentEntry,
    params: Record<string, unknown>,
  ) => {
    const started = await start(id, principal, entry, params);
    if ('error' in started) return json(c, started.error, started.status);
    const { run, contextId, read } = started;
    const configuration = isRecord(params.configuration) ? params.configuration : {};
    const history = userHistory(read, run.task, contextId, configuration.historyLength);
    if (configuration.returnImmediately === true) {
      run.result.catch(() => undefined);
      const task: A2aTask = {
        id: run.task,
        contextId,
        status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
        ...history,
        metadata: { aiGenerated: true, service: entry.id },
      };
      return json(c, rpcResult(id, { task }), 200, aiHeaders(run.task, [], entry));
    }
    const settled = await settle(run);
    const { models, metadata } = await metadataFor(entry, run.task);
    const task = await finalTask(principal, run, settled, contextId, metadata);
    return json(
      c,
      rpcResult(id, { task: { ...task, ...history } }),
      200,
      aiHeaders(run.task, models, entry),
    );
  };

  const sse = (c: Context, produce: (write: (body: RpcBody) => void) => Promise<void>) => {
    const encoder = new TextEncoder();
    let open = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const raw = (text: string) => {
          if (open) controller.enqueue(encoder.encode(text));
        };
        heartbeat = setInterval(() => raw(': ping\n\n'), heartbeatMs);
        void produce((body) => raw(`data: ${JSON.stringify(dialectOf(c, body))}\n\n`))
          .catch(() => undefined)
          .finally(() => {
            clearInterval(heartbeat);
            if (!open) return;
            open = false;
            controller.close();
          });
      },
      cancel() {
        open = false;
        clearInterval(heartbeat);
      },
    });
    return new globalThis.Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'A2A-Version': isLegacy(c) ? legacyVersion : a2aVersion,
        'genai-generated-by': 'ai',
      },
    });
  };

  const statusUpdate = (
    task: string,
    contextId: string,
    state: TaskState,
    extra: { message?: A2aMessage; metadata?: Record<string, unknown> } = {},
  ) => ({
    statusUpdate: {
      taskId: task,
      contextId,
      status: {
        state,
        timestamp: new Date().toISOString(),
        ...(extra.message ? { message: extra.message } : {}),
      },
      ...(extra.metadata ? { metadata: extra.metadata } : {}),
    },
  });

  const deltaWriter = (
    id: JsonRpcId,
    task: string,
    contextId: string,
    write: (b: RpcBody) => void,
  ) => {
    let appended = false;
    return (text: string) => {
      const part: A2aPart = { text, mediaType: 'text/plain' };
      write(
        rpcResult(id, {
          artifactUpdate: {
            taskId: task,
            contextId,
            artifact: { artifactId: `${task}-answer`, name: 'answer', parts: [part] },
            append: appended,
            lastChunk: false,
          },
        }),
      );
      appended = true;
    };
  };

  const writeFinal = (
    id: JsonRpcId,
    write: (b: RpcBody) => void,
    task: A2aTask,
    contextId: string,
  ) => {
    for (const artifact of task.artifacts ?? [])
      write(
        rpcResult(id, {
          artifactUpdate: { taskId: task.id, contextId, artifact, append: false, lastChunk: true },
        }),
      );
    write(
      rpcResult(
        id,
        statusUpdate(task.id, contextId, task.status.state, {
          ...(task.status.message ? { message: task.status.message } : {}),
          ...(task.metadata ? { metadata: task.metadata } : {}),
        }),
      ),
    );
  };

  const streamMessage = async (
    c: Context,
    id: JsonRpcId,
    principal: Principal,
    entry: AgentEntry,
    params: Record<string, unknown>,
  ) => {
    const started = await start(id, principal, entry, params);
    if ('error' in started) return json(c, started.error, started.status);
    const { run, contextId, read } = started;
    const configuration = isRecord(params.configuration) ? params.configuration : {};
    return sse(c, async (write) => {
      write(
        rpcResult(id, {
          task: {
            id: run.task,
            contextId,
            status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
            ...userHistory(read, run.task, contextId, configuration.historyLength),
          },
        }),
      );
      const delta = deltaWriter(id, run.task, contextId, write);
      const pump = (async () => {
        for await (const event of run.events) {
          const data = event.data as { text?: unknown } | undefined;
          if (event.type === 'kernel.part.delta' && typeof data?.text === 'string' && data.text)
            delta(data.text);
        }
      })();
      const settled = await settle(run);
      await pump.catch(() => undefined);
      const { metadata } = await metadataFor(entry, run.task);
      writeFinal(
        id,
        write,
        await finalTask(principal, run, settled, contextId, metadata),
        contextId,
      );
    });
  };

  const subscribe = async (
    c: Context,
    id: JsonRpcId,
    principal: Principal,
    entry: AgentEntry,
    params: Record<string, unknown>,
  ) => {
    const task = await loadTask(principal, entry, params.id);
    if (!task) return json(c, rpcError(id, errorCodes.taskNotFound, 'Task not found'));
    if (terminal(task.status))
      return json(
        c,
        rpcError(id, errorCodes.unsupported, 'The task has ended; use GetTask to read it.'),
      );
    const contextId = task.thread ?? '';
    const events = await kernel.events(principal, task.id);
    return sse(c, async (write) => {
      write(rpcResult(id, { task: toA2aTask(task) }));
      const delta = deltaWriter(id, task.id, contextId, write);
      for await (const event of events) {
        const data = event.data as { text?: unknown; status?: unknown } | undefined;
        if (event.type === 'kernel.part.delta' && typeof data?.text === 'string' && data.text)
          delta(data.text);
        if (event.type !== 'kernel.task.status' || typeof data?.status !== 'string') continue;
        if (data.status === 'interrupted' || terminal(data.status as Task['status'])) {
          const { metadata } = await metadataFor(entry, task.id);
          const done = await kernel.task(principal, task.id);
          writeFinal(id, write, { ...toA2aTask(done), metadata }, contextId);
          return;
        }
      }
    });
  };

  const cancel = async (
    c: Context,
    id: JsonRpcId,
    principal: Principal,
    entry: AgentEntry,
    params: Record<string, unknown>,
  ) => {
    const task = await loadTask(principal, entry, params.id);
    if (!task) return json(c, rpcError(id, errorCodes.taskNotFound, 'Task not found'));
    if (terminal(task.status))
      return json(c, rpcError(id, errorCodes.taskNotCancelable, 'The task has already ended.'));
    await kernel.cancel(principal, task.id);
    let current = await kernel.task(principal, task.id);
    for (let waited = 0; !terminal(current.status) && waited < cancelWaitMs; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = await kernel.task(principal, task.id);
    }
    return json(c, rpcResult(id, toA2aTask(current)));
  };

  const listTasks = async (
    c: Context,
    id: JsonRpcId,
    principal: Principal,
    entry: AgentEntry,
    params: Record<string, unknown>,
  ) => {
    if (!options.taskIds)
      return json(c, rpcError(id, errorCodes.unsupported, 'ListTasks is not supported'));
    const query = readListQuery(params);
    if ('error' in query) return json(c, rpcError(id, errorCodes.invalidParams, query.error));
    const found: A2aTask[] = [];
    for (const taskId of new Set(await options.taskIds(principal))) {
      const task = await loadTask(principal, entry, taskId);
      if (task) found.push(toA2aTask(task));
    }
    const page = pageOf(found, query);
    const tasks = await Promise.all(
      page.tasks.map(async (task) => ({
        ...task,
        metadata: (await metadataFor(entry, task.id)).metadata,
      })),
    );
    return json(c, rpcResult(id, { ...page, tasks }));
  };

  const app = new Hono();

  const unauthorized = (c: Context) =>
    c.body(JSON.stringify({ error: 'Invalid or missing API key' }), 401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
  const wellKnown = '/.well-known/agent-card.json';
  const discoverable = (c: Context) =>
    options.publicDiscovery !== undefined &&
    c.req.method === 'GET' &&
    (c.req.path === path || (c.req.path.startsWith(`${path}/`) && c.req.path.endsWith(wellKnown)));
  const authenticate = async (c: Context, next: () => Promise<void>) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal && !discoverable(c)) return unauthorized(c);
    c.set('principal' as never, principal as never);
    await next();
  };
  app.use(path, authenticate);
  app.use(`${path}/*`, authenticate);
  const principalOf = (c: Context) => c.get('principal' as never) as Principal;
  const anonymous = (c: Context) =>
    (c.get('principal' as never) as Principal | undefined) === undefined;

  const publicly = async (
    c: Context,
    answer: (discovery: PublicDiscovery) => Promise<Response>,
  ) => {
    const discovery = options.publicDiscovery as PublicDiscovery;
    const decision = await discovery.limit(c);
    if (!decision.ok)
      return c.json(
        {
          type: 'urn:genai:problem:rate-limited',
          title: 'Too many requests',
          status: 429,
          detail: 'Public agent discovery is rate limited per address.',
        },
        429,
        {
          'content-type': 'application/problem+json',
          'retry-after': String(decision.retryAfterSeconds),
        },
      );
    return answer(discovery);
  };
  const publicCardOf = (request: Request, agent: PublicAgent) =>
    publicAgentCard(agent.entry, {
      url: urlOf(request, agent.entry.id),
      provider: {
        organization: agent.provider?.organization ?? options.provider?.organization ?? '',
        url:
          agent.provider?.url ??
          options.provider?.url ??
          new URL(urlOf(request, agent.entry.id)).origin,
      },
    });

  app.get(path, async (c) => {
    if (anonymous(c))
      return publicly(c, async (discovery) =>
        c.json({ agents: (await discovery.list()).map((agent) => publicCardOf(c.req.raw, agent)) }),
      );
    const listed = await agents(principalOf(c));
    return c.json({ agents: listed.map((entry) => cardOf(c.req.raw, entry)) });
  });

  const card = async (c: Context) => {
    if (anonymous(c))
      return publicly(c, async (discovery) => {
        const agent = await discovery.resolve(c.req.param('agent') ?? '');
        if (!agent) return unauthorized(c);
        return c.json(publicCardOf(c.req.raw, agent), 200, { 'A2A-Version': a2aVersion });
      });
    const found = await agentFor(principalOf(c), c.req.param('agent') ?? '');
    if (!found.ok) return c.json({ error: found.message, code: found.code }, 404);
    return c.json(cardOf(c.req.raw, found.entry), 200, { 'A2A-Version': a2aVersion });
  };
  app.get(`${path}/:agent/.well-known/agent-card.json`, card);
  app.get(`${path}/:agent`, card);

  app.post(`${path}/:agent`, async (c) => {
    const principal = principalOf(c);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > maxBody)
      return json(
        c,
        rpcError(null, errorCodes.invalidRequest, `Request body exceeds ${maxBody} bytes`),
        413,
      );
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      return json(c, rpcError(null, errorCodes.parse, (error as Error).message), 400);
    }
    if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
      return json(c, rpcError(null, errorCodes.invalidRequest, 'Not a JSON-RPC 2.0 request'), 400);
    const id = (
      typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null
    ) as JsonRpcId;
    const version = c.req.header('a2a-version') ?? c.req.query('A2A-Version');
    if (!supportedVersion(version))
      return json(
        c,
        rpcError(id, errorCodes.versionNotSupported, `A2A version ${version} is not supported`, {
          supported: [a2aVersion, legacyVersion],
        }),
      );
    const legacyMethod = legacyMethods[body.method];
    const legacy =
      version?.trim() === legacyVersion || (!version?.trim() && legacyMethod !== undefined);
    if (legacy) c.set(legacyDialect, true as never);
    const method = legacy ? (legacyMethod ?? '') : body.method;
    const found = await agentFor(principal, c.req.param('agent') ?? '');
    if (!found.ok)
      return json(
        c,
        rpcError(id, errorCodes.invalidParams, found.message, { code: found.code }),
        found.code === 'service_paused' ? 503 : 404,
      );
    const entry = found.entry;
    const raw = isRecord(body.params) ? body.params : {};
    const params = legacy ? fromLegacyParams(raw) : raw;
    try {
      switch (method) {
        case 'SendMessage':
          return await sendMessage(c, id, principal, entry, params);
        case 'SendStreamingMessage':
          return await streamMessage(c, id, principal, entry, params);
        case 'GetTask': {
          const task = await loadTask(principal, entry, params.id);
          if (!task) return json(c, rpcError(id, errorCodes.taskNotFound, 'Task not found'));
          const { metadata } = await metadataFor(entry, task.id);
          return json(c, rpcResult(id, toA2aTask(task, { metadata })));
        }
        case 'CancelTask':
          return await cancel(c, id, principal, entry, params);
        case 'SubscribeToTask':
          return await subscribe(c, id, principal, entry, params);
        case 'ListTasks':
          return await listTasks(c, id, principal, entry, params);
        case 'CreateTaskPushNotificationConfig':
        case 'GetTaskPushNotificationConfig':
        case 'ListTaskPushNotificationConfigs':
        case 'DeleteTaskPushNotificationConfig':
          return json(
            c,
            rpcError(id, errorCodes.pushNotSupported, 'Push notifications are not supported'),
          );
        case 'GetExtendedAgentCard':
          return json(
            c,
            rpcError(id, errorCodes.extendedCardNotConfigured, 'There is no extended agent card'),
          );
        default:
          return json(
            c,
            rpcError(id, errorCodes.methodNotFound, `Method not found: ${body.method}`),
          );
      }
    } catch (error) {
      return json(
        c,
        rpcError(id, errorCodes.internal, error instanceof Error ? error.message : String(error)),
      );
    }
  });

  return app;
};
