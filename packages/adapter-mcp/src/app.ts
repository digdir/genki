import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  checkInputFields,
  fieldsQuery,
  type Event,
  type Input,
  type InputValue,
  type Part,
  type Principal,
} from '@genai/contracts';
import { KernelError, type Kernel, type Run } from '@genai/kernel';
import { progressTracker } from './progress.js';
import {
  discoverTtlMs,
  internalError,
  invalidParams,
  methodNotFound,
  negotiatedVersion,
  parseError,
  protocolVersion,
  result,
  rpcError,
  supportedVersions,
  toolsListTtlMs,
  validateRequest,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcResult,
} from './protocol.js';
import {
  defaultInput,
  defaultInstructions,
  defaultOutput,
  invalidParamsCodes,
  readOverrides,
  readQuery,
  requiresQuery,
  resourceLinks,
  structuredContent,
  toolEntry,
  type Authenticator,
  type CapabilityEntry,
  type CapabilityResolver,
  type History,
  type OverridePolicy,
  type ToolOutput,
} from './tools.js';

export interface TurnChunk {
  chunkId: string;
  docTitle: string;
  docNum?: string;
  contentMarkdown: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
  chunks?: TurnChunk[];
  diagnostics?: unknown;
}

export type OpenedConversation =
  { ok: true; id: string; history: History[] } | { ok: false; code: string; message: string };

export interface McpConversations {
  open(
    request: Request,
    input: { conversationId?: string; agentId: string },
  ): Promise<OpenedConversation>;
  append(request: Request, conversationId: string, turn: ConversationTurn): Promise<void>;
}

export interface McpAppOptions {
  kernel: Kernel;
  resolver: CapabilityResolver;
  auth: Authenticator;
  history?: (principal: Principal, conversationId: string) => Promise<History[]>;
  conversations?: McpConversations;
  path?: string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
  input?: (
    entry: CapabilityEntry,
    args: Record<string, unknown>,
    query: string | undefined,
    history: History[],
  ) => Input;
  output?: (parts: Part[]) => ToolOutput;
  conversationId?: () => string;
  maxBodyBytes?: number;
  heartbeatMs?: number;
  overridePolicy?: OverridePolicy;
  modelsOf?: (task: string) => Promise<string[]>;
}

type Response = JsonRpcResult | JsonRpcError;

interface CallOutcome {
  response: Response;
  status: number;
  headers: Record<string, string>;
}

const versionHeader = 'genai-version';

const readVersion = (value: string | undefined): { version?: number } | { error: string } => {
  if (value === undefined || value.trim() === '') return {};
  const trimmed = value.trim();
  return /^[1-9]\d{0,8}$/.test(trimmed)
    ? { version: Number(trimmed) }
    : { error: '`GenAI-Version` must be a positive whole number.' };
};

const generatedHeaders = (models: string[], version?: number): Record<string, string> => ({
  'genai-generated-by': 'ai',
  ...(models.length === 1 && models[0] ? { 'genai-model': models[0] } : {}),
  ...(version === undefined ? {} : { 'genai-service-version': String(version) }),
});

const outcomeOf = (response: Response, status = 200, headers: Record<string, string> = {}) => ({
  response,
  status,
  headers,
});

const resolveStatus: Record<string, number> = { service_paused: 503, version_not_found: 409 };

const alphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

export const nanoId = (size = 21) =>
  [...crypto.getRandomValues(new Uint8Array(size))].map((b) => alphabet[b & 63]).join('');

const jsonHeaders = { 'Content-Type': 'application/json', 'MCP-Protocol-Version': protocolVersion };

const toolError = (message: string, code: string) => ({
  content: [{ type: 'text', text: message }],
  isError: true,
  _meta: { code },
});

const markForm = (input: Input, form: boolean): Input =>
  form && input.parts
    ? {
        ...input,
        parts: input.parts.map((p) =>
          p.body.kind === 'text' ? { ...p, meta: { ...p.meta, inputFields: true } } : p,
        ),
      }
    : input;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

const datasetScope = (args: Record<string, unknown>, entry: CapabilityEntry) => {
  const tenant = nonEmpty(args.tenant);
  const key = nonEmpty(args.dataset_config_key);
  if (!tenant || !key || !entry.datasets) return undefined;
  const requested = `${tenant}/${key}`;
  return entry.datasets.includes(requested)
    ? undefined
    : `Agent ${entry.agentId ?? entry.id} is not allowed to access the requested dataset: ${requested}`;
};

const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

const assistantTurn = (output: ToolOutput): ConversationTurn => {
  const s = output.structured;
  const chunks = Array.isArray(s.chunks) ? (s.chunks as Record<string, unknown>[]) : [];
  const attribution = isRecord(s.search_attribution) ? [s.search_attribution] : [];
  return {
    role: 'assistant',
    text: output.text,
    chunks: chunks.slice(0, 20).map((c) => {
      const docNum = text(c.doc_num);
      return {
        chunkId: String(c.chunk_id),
        docTitle: text(c.title) ?? '',
        ...(docNum === undefined ? {} : { docNum }),
        contentMarkdown: text(c.content_markdown) ?? '',
      };
    }),
    diagnostics: {
      ...(isRecord(s.execution_metadata) ? { 'execution-metadata': s.execution_metadata } : {}),
      'backend-issues': [],
      'search-attributions': attribution,
    },
  };
};

export const createMcpApp = (options: McpAppOptions) => {
  const { kernel, resolver, auth } = options;
  const path = options.path ?? '/api/mcp';
  const serverInfo = options.serverInfo ?? { name: 'digdir-rag', version: '1.0' };
  const mapInput =
    options.input ?? ((_entry, args, query, history) => defaultInput(args, query, history));
  const loadHistory = options.history ?? (async () => []);
  const mapOutput = options.output ?? defaultOutput;
  const newConversation = options.conversationId ?? (() => nanoId());
  const maxBody = options.maxBodyBytes ?? 1_048_576;
  const heartbeatMs = options.heartbeatMs ?? 15_000;

  const json = (c: Context, status: number, body: unknown, headers: Record<string, string> = {}) =>
    c.body(JSON.stringify(body), status as 200, {
      ...jsonHeaders,
      'MCP-Protocol-Version':
        (c.get('mcpVersion' as never) as string | undefined) ?? protocolVersion,
      ...headers,
    });
  const modelsOf = async (task: string) => {
    try {
      return (await options.modelsOf?.(task)) ?? [];
    } catch {
      return [];
    }
  };

  interface CallHooks {
    request: Request;
    signal: AbortSignal;
    version?: number;
    onRun?: (run: Run) => void;
    onEvent?: (event: Event) => void;
  }

  const callTool = async (
    id: JsonRpcId,
    principal: Principal,
    name: string,
    args: Record<string, unknown>,
    hooks: CallHooks,
  ): Promise<CallOutcome> => {
    try {
      if (name.indexOf('__') <= 0) {
        return outcomeOf(
          invalidParams(id, `Tool name must contain '__': ${name}`, {
            code: 'invalid_tool_name',
          }),
        );
      }
      const resolved = await resolver.resolve(
        principal,
        name,
        hooks.version === undefined ? {} : { version: hooks.version },
      );
      if (!resolved.ok) {
        const status = resolveStatus[resolved.code];
        if (status)
          return outcomeOf(
            rpcError(id, status === 409 ? -32602 : -32603, resolved.message, {
              code: resolved.code,
            }),
            status,
          );
        return outcomeOf(
          invalidParamsCodes.has(resolved.code)
            ? invalidParams(id, resolved.message, { code: resolved.code })
            : result(id, toolError(resolved.message, resolved.code)),
        );
      }
      const { entry } = resolved;
      const outOfScope = datasetScope(args, entry);
      if (outOfScope) return outcomeOf(result(id, toolError(outOfScope, 'dataset_not_authorized')));
      let query = readQuery(args);
      let values: Record<string, InputValue> = {};
      if (entry.inputFields?.length) {
        const checked = checkInputFields(entry.inputFields, args);
        if (!checked.ok)
          return outcomeOf(
            result(id, {
              ...toolError(checked.errors.map((e) => e.message).join(' '), 'invalid_input'),
              structuredContent: { errors: checked.errors },
            }),
          );
        values = checked.values;
        query = fieldsQuery(entry.inputFields, values, query) || undefined;
        if (!query)
          return outcomeOf(
            result(
              id,
              toolError('Fyll ut feltene eller send et spørsmål i `query`.', 'missing_query'),
            ),
          );
      }
      if (!query && requiresQuery(entry.inputSchema)) {
        return outcomeOf(
          result(
            id,
            toolError('Tool call requires a non-empty `query` argument.', 'missing_query'),
          ),
        );
      }
      const overrides = readOverrides(args.overrides, {
        settings: Boolean(options.overridePolicy),
      });
      if (overrides.error)
        return outcomeOf(invalidParams(id, overrides.error, { code: 'invalid_overrides' }));
      const allowed = await options.overridePolicy?.check(principal, overrides.overrides, {
        capability: entry.capability,
        entryPoint: 'mcp',
      });
      if (allowed && !allowed.ok)
        return outcomeOf(invalidParams(id, allowed.message, { code: 'invalid_overrides' }));

      const requested = nonEmpty(args.conversation_id);
      let conversationId: string;
      let history: History[] = [];
      if (options.conversations) {
        const opened = await options.conversations.open(hooks.request, {
          ...(requested ? { conversationId: requested } : {}),
          agentId: entry.agentId ?? entry.id,
        });
        if (!opened.ok) return outcomeOf(result(id, toolError(opened.message, opened.code)));
        conversationId = opened.id;
        history = opened.history;
      } else {
        conversationId = requested ?? newConversation();
        if (requested) history = await loadHistory(principal, requested);
      }
      const meta = {
        conversation_id: conversationId,
        ...(entry.mode === undefined ? {} : { mode: entry.mode }),
        ...(entry.agentId === undefined ? {} : { agent_id: entry.agentId }),
      };

      let run: Run;
      await options.conversations?.append(hooks.request, conversationId, {
        role: 'user',
        text: query ?? '',
      });
      try {
        run = await kernel.invoke(
          principal,
          entry.capability,
          markForm(
            mapInput(entry, { ...args, ...values }, query, history),
            !!entry.inputFields?.length,
          ),
          { thread: conversationId, entryPoint: 'mcp' },
        );
      } catch (error) {
        if (error instanceof KernelError)
          return outcomeOf(result(id, toolError(error.message, error.code)));
        throw error;
      }
      hooks.onRun?.(run);
      const abort = () => void kernel.cancel(principal, run.task).catch(() => undefined);
      if (hooks.signal.aborted) abort();
      else hooks.signal.addEventListener('abort', abort, { once: true });

      const pump = hooks.onEvent
        ? (async () => {
            for await (const event of run.events) hooks.onEvent?.(event);
          })()
        : Promise.resolve();

      let parts: Part[];
      try {
        parts = await run.result;
      } catch (error) {
        await pump.catch(() => undefined);
        const code = error instanceof KernelError ? error.code : 'strategy_error';
        const message = error instanceof KernelError ? error.message : 'the service failed';
        return outcomeOf(
          result(id, {
            content: [{ type: 'text', text: message }],
            structuredContent: { conversation_id: conversationId },
            isError: true,
            _meta: { ...meta, status: 'error', insufficient: false, code },
          }),
        );
      } finally {
        hooks.signal.removeEventListener('abort', abort);
      }
      await pump.catch(() => undefined);

      const output = mapOutput(parts);
      await options.conversations
        ?.append(hooks.request, conversationId, assistantTurn(output))
        .catch(() => undefined);
      const models = await modelsOf(run.task);
      return outcomeOf(
        result(id, {
          content: [{ type: 'text', text: output.text }, ...resourceLinks(output.structured)],
          structuredContent: structuredContent(output.structured, conversationId),
          isError: false,
          _meta: {
            ...meta,
            status: output.structured.clarification ? 'needs-clarification' : 'complete',
            insufficient: Boolean(output.structured.insufficient),
            ...(output.structured.no_answer ? { no_answer: true } : {}),
            ...(output.structured.clarification
              ? { clarification: output.structured.clarification }
              : {}),
            ...(isRecord(output.structured.execution_metadata)
              ? { execution_metadata: output.structured.execution_metadata }
              : {}),
            ai_generated: true,
            ...(models.length === 1 ? { model: models[0] } : {}),
            ...(entry.version === undefined ? {} : { service_version: entry.version }),
          },
        }),
        200,
        { ...generatedHeaders(models, entry.version), 'genai-task': run.task },
      );
    } catch (error) {
      return outcomeOf(
        internalError(id, error instanceof Error ? error.message : String(error), {
          tool: name,
        }),
      );
    }
  };

  const streamToolCall = (
    c: Context,
    id: JsonRpcId,
    principal: Principal,
    name: string,
    args: Record<string, unknown>,
    token: unknown,
    version: number | undefined,
  ) => {
    const encoder = new TextEncoder();
    const abort = new AbortController();
    const track = progressTracker(token, readQuery(args));
    let open = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => {
          if (open) controller.enqueue(encoder.encode(text));
        };
        heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
        void callTool(id, principal, name, args, {
          request: c.req.raw,
          signal: abort.signal,
          ...(version === undefined ? {} : { version }),
          onEvent: (event) => {
            for (const frame of track(event)) write(`data: ${JSON.stringify(frame)}\n\n`);
          },
        }).then(({ response }) => {
          clearInterval(heartbeat);
          if (!open) return;
          write(`data: ${JSON.stringify(response)}\n\n`);
          open = false;
          controller.close();
        });
      },
      cancel() {
        open = false;
        clearInterval(heartbeat);
        abort.abort();
      },
    });
    c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true });
    return new globalThis.Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'genai-generated-by': 'ai',
      },
    });
  };

  const app = new Hono();

  app.use(path, async (c, next) => {
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) {
      return c.body(JSON.stringify({ error: 'Invalid or missing API key' }), 401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      });
    }
    c.set('principal' as never, principal as never);
    await next();
  });

  const notAllowed = (c: Context) =>
    c.body(
      JSON.stringify(
        rpcError(null, -32601, 'Method Not Allowed: the MCP endpoint accepts POST only', {
          allow: ['POST'],
        }),
      ),
      405,
      { 'Content-Type': 'application/json', Allow: 'POST' },
    );
  app.get(path, notAllowed);
  app.delete(path, notAllowed);

  app.use(
    path,
    bodyLimit({
      maxSize: maxBody,
      onError: (c) => json(c, 413, parseError(`Request body exceeds ${maxBody} bytes`)),
    }),
  );
  app.post(path, async (c) => {
    const principal = c.get('principal' as never) as Principal;
    const text = await c.req.text();
    if (text.trim() === '') return json(c, 400, parseError('Empty request body'));
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      return json(c, 400, parseError((error as Error).message));
    }
    if (body === null) return json(c, 400, parseError('Empty request body'));
    if (!isRecord(body)) return json(c, 400, parseError('Batched requests are not supported'));
    if (!('id' in body)) return c.body(null, 202);

    const invalid = validateRequest(c.req.raw.headers, body);
    if (invalid) return json(c, invalid.status, invalid.error);

    const id = body.id as JsonRpcId;
    const params = isRecord(body.params) ? body.params : {};
    const requested = c.req.header('MCP-Protocol-Version');
    const version =
      body.method === 'initialize'
        ? negotiatedVersion(params.protocolVersion)
        : requested && supportedVersions.includes(requested)
          ? requested
          : protocolVersion;
    c.set('mcpVersion' as never, version as never);

    switch (body.method) {
      case 'initialize':
        return json(
          c,
          200,
          result(id, {
            protocolVersion: version,
            capabilities: { tools: {} },
            serverInfo,
            instructions: options.instructions ?? defaultInstructions,
          }),
        );
      case 'server/discover':
        return json(
          c,
          200,
          result(id, {
            supportedVersions,
            capabilities: { tools: {} },
            _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
            ttlMs: discoverTtlMs,
            cacheScope: 'public',
            instructions: options.instructions ?? defaultInstructions,
          }),
        );
      case 'tools/list':
        try {
          const listed = await resolver.list(principal);
          return json(
            c,
            200,
            result(id, {
              tools: listed.map(toolEntry),
              _meta: { 'request-id': nanoId() },
              ttlMs: toolsListTtlMs,
              cacheScope: 'private',
            }),
          );
        } catch (error) {
          return json(c, 200, internalError(id, (error as Error).message));
        }
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string')
          return json(c, 200, invalidParams(id, 'tools/call requires :name'));
        const args = isRecord(params.arguments) ? params.arguments : {};
        const pinned = readVersion(c.req.header(versionHeader));
        if ('error' in pinned)
          return json(c, 400, invalidParams(id, pinned.error, { code: 'invalid_version' }));
        const meta = isRecord(params._meta) ? params._meta : {};
        const token = meta.progressToken ?? meta.progress_token;
        if (token !== undefined && token !== null)
          return streamToolCall(c, id, principal, name, args, token, pinned.version);
        const outcome = await callTool(id, principal, name, args, {
          request: c.req.raw,
          signal: c.req.raw.signal,
          ...pinned,
        });
        return json(c, outcome.status, outcome.response, outcome.headers);
      }
      default:
        return json(c, 404, methodNotFound(id, body.method));
    }
  });

  return app;
};
