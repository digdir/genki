import { Hono, type Context } from 'hono';
import type { Principal } from '@genai/contracts';
import { activeBranch } from './branches.js';
import {
  normalizeTags,
  type Conversation,
  type ConversationStore,
  type Message,
  type Owner,
} from './store.js';

export interface ConversationCaller {
  principal: Principal;
  externalUsers?: boolean;
}

export interface ConversationAuthenticator {
  authenticate(request: Request): Promise<ConversationCaller | undefined>;
}

export type AgentChoice =
  | { ok: true; agentId: string }
  | { ok: false; status: 400 | 403 | 404 | 503; error: string; available?: string[] };

export type AgentSelector = (
  caller: ConversationCaller,
  requested?: string,
) => Promise<AgentChoice>;

export interface ConversationRoutesOptions {
  store: ConversationStore;
  auth: ConversationAuthenticator;
  selectAgent: AgentSelector;
  onDeleted?: (owner: Owner, id: string) => Promise<void>;
}

const maxPageSize = 100;

const updatableKeys = new Set(['title', 'topic', 'tags']);

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 503,
    message: string,
    readonly available?: string[],
    readonly code?: string,
  ) {
    super(message);
  }
}

const codeFor: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  503: 'unavailable',
};

const problemOf = (status: number, message: string, code: string) => ({
  error: message,
  type: 'about:blank',
  title: message,
  status,
  detail: message,
  code,
});

const fail = (c: Context, error: unknown, fallback: string) => {
  if (error instanceof HttpError) {
    return c.json(
      {
        ...problemOf(error.status, error.message, error.code ?? codeFor[error.status] ?? 'error'),
        ...(error.available ? { available: error.available } : {}),
      },
      error.status,
      { 'content-type': 'application/problem+json' },
    );
  }
  return c.json(problemOf(500, fallback, 'internal_error'), 500, {
    'content-type': 'application/problem+json',
  });
};

const publicConversation = (c: Conversation) => ({
  id: c.id,
  topic: c.topic,
  agentId: c.agentId,
  serviceId: c.agentId,
  userId: c.userId,
  tags: c.tags,
  created: c.created,
});

const publicMessage = (m: Message, diagnostics: boolean) => ({
  id: m.id,
  text: m.text,
  role: m.role ?? null,
  created: m.created,
  tags: m.tags,
  filterValue: m.filterValue ?? null,
  chunks: m.chunks.map((chunk) => ({
    chunkId: chunk.chunkId,
    docTitle: chunk.docTitle,
    docNum: chunk.docNum ?? null,
    contentMarkdown: chunk.contentMarkdown,
  })),
  ...(m.sources?.length ? { sources: m.sources } : {}),
  ...(diagnostics && m.diagnostics !== undefined ? { diagnostics: m.diagnostics } : {}),
  ...(m.task === undefined ? {} : { task: m.task }),
  ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  ...(m.input ? { input: m.input } : {}),
});

const pick = (body: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
};

const intParam = (raw: string | undefined, fallback: number, min: number, max: number) => {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `Invalid parameter value: ${raw}`);
  const value = Number(raw);
  if (value < min || value > max) throw new HttpError(400, `Invalid parameter value: ${raw}`);
  return value;
};

const stringList = (value: unknown, name: string) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.length > 0))
    throw new HttpError(400, `Invalid parameter value: ${name}`);
  return value as string[];
};

export const userKey = (principal: Principal) => `${principal.issuer}|${principal.subject}`;

export const ownerOf = (
  caller: ConversationCaller,
  request: Request,
): { owner: Owner; userId: string } => {
  const tenant = caller.principal.tenant;
  if (!tenant) throw new HttpError(403, 'Forbidden');
  const external = request.headers.get('x-user-id')?.trim();
  if (!external || !caller.externalUsers)
    return { owner: { tenant, user: userKey(caller.principal) }, userId: caller.principal.subject };
  return { owner: { tenant, user: `${userKey(caller.principal)}#${external}` }, userId: external };
};

const readBody = async (c: Context): Promise<Record<string, unknown>> => {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
  throw new HttpError(400, 'Malformed JSON body');
};

export const conversationRoutes = ({
  store,
  auth,
  selectAgent,
  onDeleted,
}: ConversationRoutesOptions) => {
  const app = new Hono();

  const caller = async (c: Context) => {
    const found = await auth.authenticate(c.req.raw);
    if (!found) throw new HttpError(401, 'Unauthorized');
    return { caller: found, ...ownerOf(found, c.req.raw) };
  };

  app.get('/api/conversations', async (c) => {
    try {
      const { owner } = await caller(c);
      const pageSize = intParam(c.req.query('page_size'), 50, 1, maxPageSize);
      const pageIndex = intParam(c.req.query('page_index'), 0, 0, Number.MAX_SAFE_INTEGER);
      const tags = normalizeTags((c.req.queries('tags') ?? []).flatMap((t) => t.split(/\s*,\s*/)));
      const { conversations, total } = await store.list(owner, { pageSize, pageIndex, tags });
      return c.json({
        conversations: conversations.map(publicConversation),
        total,
        pageSize,
        pageIndex,
      });
    } catch (error) {
      return fail(c, error, 'Failed to list conversations');
    }
  });

  app.post('/api/conversations', async (c) => {
    try {
      const { caller: who, owner, userId } = await caller(c);
      const body = await readBody(c);
      const requested = pick(
        body,
        'service',
        'service-id',
        'serviceId',
        'service_id',
        'agent-id',
        'agentId',
        'agent_id',
        'agent',
      );
      if (requested !== undefined && typeof requested !== 'string')
        throw new HttpError(400, 'Invalid parameter value: service');
      const title = pick(body, 'title');
      if (title !== undefined && typeof title !== 'string')
        throw new HttpError(400, 'Invalid parameter value: title');
      const tags = stringList(body.tags, 'tags');
      const choice = await selectAgent(who, requested);
      if (!choice.ok) throw new HttpError(choice.status, choice.error, choice.available);
      const conversation = await store.create(owner, {
        agentId: choice.agentId,
        userId,
        ...(title === undefined ? {} : { topic: title }),
        ...(tags === undefined ? {} : { tags }),
        filterValue: pick(body, 'filter-value', 'filterValue', 'filter_value'),
      });
      return c.json({ conversation: publicConversation(conversation) }, 201);
    } catch (error) {
      return fail(c, error, 'Failed to create conversation');
    }
  });

  app.get('/api/conversations/:id', async (c) => {
    try {
      const { owner } = await caller(c);
      const id = c.req.param('id');
      const conversation = await store.get(owner, id);
      const messages = conversation && (await store.messages(owner, id));
      if (!conversation || !messages)
        throw new HttpError(404, 'Conversation not found', undefined, 'conversation_not_found');
      const diagnostics = c.req.query('include_diagnostics') === 'true';
      return c.json({
        conversation: publicConversation(conversation),
        messages: (c.req.query('branches') === 'all' ? messages : activeBranch(messages))
          .filter((m) => m.role !== 'system')
          .map((m) => publicMessage(m, diagnostics)),
      });
    } catch (error) {
      return fail(c, error, 'Failed to get conversation');
    }
  });

  app.put('/api/conversations/:id', async (c) => {
    try {
      const { owner } = await caller(c);
      const body = await readBody(c);
      const unknown = Object.keys(body).filter((key) => !updatableKeys.has(key));
      if (unknown.length > 0)
        throw new HttpError(
          400,
          `Unknown field: ${unknown.join(', ')}`,
          undefined,
          'unknown_field',
        );
      const title = pick(body, 'title', 'topic');
      if (title !== undefined && typeof title !== 'string')
        throw new HttpError(400, 'Invalid parameter value: title');
      const tags = stringList(body.tags, 'tags');
      const updated = await store.update(owner, c.req.param('id'), {
        ...(title === undefined ? {} : { topic: title }),
        ...(tags === undefined ? {} : { tags }),
      });
      if (!updated)
        throw new HttpError(404, 'Conversation not found', undefined, 'conversation_not_found');
      return c.json({ conversation: publicConversation(updated) });
    } catch (error) {
      return fail(c, error, 'Failed to update conversation');
    }
  });

  app.delete('/api/conversations/:id', async (c) => {
    try {
      const { owner } = await caller(c);
      const id = c.req.param('id');
      if (!(await store.delete(owner, id)))
        throw new HttpError(404, 'Conversation not found', undefined, 'conversation_not_found');
      await onDeleted?.(owner, id);
      return c.json({ success: true });
    } catch (error) {
      return fail(c, error, 'Failed to delete conversation');
    }
  });

  return app;
};
