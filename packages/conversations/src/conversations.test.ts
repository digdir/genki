import { describe, expect, it } from 'vitest';
import {
  conversationRoutes,
  conversationTurns,
  InMemoryConversationStore,
  type AgentSelector,
  type ConversationCaller,
  type ConversationStore,
  type Owner,
} from './index.js';

const callers: Record<string, ConversationCaller> = {
  ka: {
    principal: {
      kind: 'agency-system',
      issuer: 'legacy-api-key',
      subject: 'key-ka',
      tenant: '991825827',
    },
    externalUsers: true,
  },
  other: {
    principal: {
      kind: 'agency-system',
      issuer: 'legacy-api-key',
      subject: 'key-nav',
      tenant: '889640782',
    },
    externalUsers: true,
  },
  unbound: {
    principal: {
      kind: 'agency-system',
      issuer: 'legacy-api-key',
      subject: 'key-unbound',
      tenant: '991825827',
    },
  },
  frontend: {
    principal: {
      kind: 'agency-system',
      issuer: 'legacy-api-key',
      subject: 'key-frontend',
      tenant: '991825827',
    },
    externalUsers: true,
  },
  kari: {
    principal: {
      kind: 'employee',
      issuer: 'https://ansattporten.no',
      subject: 'kari',
      tenant: '991825827',
    },
  },
  ola: {
    principal: {
      kind: 'employee',
      issuer: 'https://ansattporten.no',
      subject: 'ola',
      tenant: '991825827',
    },
  },
  homeless: { principal: { kind: 'employee', issuer: 'https://ansattporten.no', subject: 'x' } },
};

const selectAgent: AgentSelector = async (_caller, requested) => {
  const agents = ['kunnskapsassistenten__default', 'kunnskapsassistenten-retrieve-only__default'];
  if (requested === undefined)
    return {
      ok: false,
      status: 400,
      error: 'Multiple agents available; specify agent-id',
      available: agents,
    };
  return agents.includes(requested)
    ? { ok: true, agentId: requested }
    : { ok: false, status: 404, error: `Agent not found: ${requested}` };
};

const AGENT = 'kunnskapsassistenten__default';

const setup = (store: ConversationStore = new InMemoryConversationStore()) => {
  const app = conversationRoutes({
    store,
    selectAgent,
    auth: {
      authenticate: async (request) => {
        const who = request.headers.get('authorization')?.replace('Bearer ', '');
        return who ? callers[who] : undefined;
      },
    },
  });
  const send = (
    path: string,
    who?: string,
    init: { method?: string; body?: unknown; user?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(init.user ? { 'x-user-id': init.user } : {}),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { send, store };
};

const create = async (
  send: ReturnType<typeof setup>['send'],
  who: string,
  user?: string,
  body: unknown = { 'agent-id': AGENT },
) => {
  const response = await send('/api/conversations', who, {
    method: 'POST',
    body,
    ...(user ? { user } : {}),
  });
  return {
    response,
    json: (await response.json()) as {
      conversation: { id: string; created: unknown; userId: string };
    },
  };
};

describe('conversation API', () => {
  it('a conversation names its service with service as well as agent, and returns both ids', async () => {
    const { send } = setup();
    const { response, json } = await create(send, 'ka', 'user-1', { service: AGENT });

    expect(response.status).toBe(201);
    expect(json.conversation).toMatchObject({ agentId: AGENT, serviceId: AGENT });
  });

  it('creates a thread with the default topic and the filter message', async () => {
    const { send } = setup();
    const { response, json } = await create(send, 'ka', 'user-1', {
      agentId: AGENT,
      filterValue: {
        fields: [{ field: 'orgs_short', type: 'multiselect', 'selected-options': ['DIGDIR'] }],
      },
      tags: [' a ', 'b', 'a'],
    });

    expect(response.status).toBe(201);
    expect(json.conversation).toMatchObject({
      topic: 'Ny tråd',
      agentId: AGENT,
      userId: 'user-1',
      tags: ['a', 'b'],
    });
    expect(typeof json.conversation.created).toBe('number');

    const detail = (await (
      await send(`/api/conversations/${json.conversation.id}`, 'ka', { user: 'user-1' })
    ).json()) as {
      messages: {
        role: string | null;
        text: string;
        filterValue: unknown;
        chunks: unknown[];
        tags: string[];
      }[];
    };
    expect(detail.messages.map((m) => [m.role, m.text])).toEqual([[null, '']]);
    expect(detail.messages[0]?.filterValue).toEqual({
      fields: [{ field: 'orgs_short', type: 'multiselect', 'selected-options': ['DIGDIR'] }],
    });
  });

  it('ignores X-User-Id from signed-in employees and from keys not bound to a service', async () => {
    const { send } = setup();

    expect((await send('/api/conversations', 'ka')).status).toBe(200);
    const { json } = await create(send, 'kari', 'spoofed');
    expect(json.conversation.userId).toBe('kari');
    const unbound = await create(send, 'unbound', 'spoofed');
    expect(unbound.json.conversation.userId).toBe('key-unbound');
  });

  it('lets a service key bound to a frontend name its end users with X-User-Id, and works without it', async () => {
    const { send } = setup();

    const ola = await create(send, 'frontend', 'ola');
    const shared = await create(send, 'frontend');

    expect(ola.json.conversation.userId).toBe('ola');
    expect(shared.json.conversation.userId).toBe('key-frontend');
    expect((await send(`/api/conversations/${ola.json.conversation.id}`, 'frontend')).status).toBe(
      404,
    );
    expect(
      (await send(`/api/conversations/${ola.json.conversation.id}`, 'frontend', { user: 'ola' }))
        .status,
    ).toBe(200);
  });

  it('pages newest first, filters on every tag, and caps the page size', async () => {
    let clock = 1_000;
    const { send } = setup(new InMemoryConversationStore(() => (clock += 10)));
    for (const tags of [['x'], ['x', 'y'], ['y']])
      await create(send, 'ka', 'user-1', { 'agent-id': AGENT, tags });

    const page = (await (
      await send('/api/conversations?page_size=2&page_index=0', 'ka', { user: 'user-1' })
    ).json()) as {
      conversations: { tags: string[]; created: number }[];
      total: number;
      pageSize: number;
      pageIndex: number;
    };
    const tagged = (await (
      await send('/api/conversations?tags=x,y', 'ka', { user: 'user-1' })
    ).json()) as { total: number };
    const repeated = (await (
      await send('/api/conversations?tags=x&tags=y', 'ka', { user: 'user-1' })
    ).json()) as { total: number };

    expect(page).toMatchObject({ total: 3, pageSize: 2, pageIndex: 0 });
    expect(page.conversations.map((c) => c.tags)).toEqual([['y'], ['x', 'y']]);
    expect(tagged.total).toBe(1);
    expect(repeated.total).toBe(1);
    expect((await send('/api/conversations?page_size=101', 'ka', { user: 'user-1' })).status).toBe(
      400,
    );
    expect((await send('/api/conversations?page_size=0', 'ka', { user: 'user-1' })).status).toBe(
      400,
    );
  });

  it('renames, retags and deletes only your own threads', async () => {
    const { send } = setup();
    const { json } = await create(send, 'ka', 'user-1');
    const id = json.conversation.id;

    const renamed = await send(`/api/conversations/${id}`, 'ka', {
      method: 'PUT',
      user: 'user-1',
      body: { title: 'Tildelingsbrev', tags: ['viktig'] },
    });
    expect(await renamed.json()).toMatchObject({
      conversation: { topic: 'Tildelingsbrev', tags: ['viktig'] },
    });

    const deleted = await send(`/api/conversations/${id}`, 'ka', {
      method: 'DELETE',
      user: 'user-1',
    });
    expect(await deleted.json()).toEqual({ success: true });
    expect((await send(`/api/conversations/${id}`, 'ka', { user: 'user-1' })).status).toBe(404);
  });

  it('hides threads from other users, other keys and other tenants with the same 404', async () => {
    const { send } = setup();
    const { json } = await create(send, 'ka', 'user-1');
    const mine = (await create(send, 'kari')).json.conversation.id;
    const id = json.conversation.id;
    const notFound = { error: 'Conversation not found', code: 'conversation_not_found' };

    for (const [who, user] of [
      ['ka', 'user-2'],
      ['other', 'user-1'],
      ['kari', undefined],
    ] as const) {
      const response = await send(`/api/conversations/${id}`, who, user ? { user } : {});
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject(notFound);
      expect(
        (
          await send(`/api/conversations/${id}`, who, {
            method: 'DELETE',
            ...(user ? { user } : {}),
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await send(`/api/conversations/${id}`, who, {
            method: 'PUT',
            body: { title: 'x' },
            ...(user ? { user } : {}),
          })
        ).status,
      ).toBe(404);
    }
    expect((await send(`/api/conversations/${mine}`, 'ola')).status).toBe(404);
    expect((await send(`/api/conversations/${mine}`, 'kari')).status).toBe(200);
    const list = (await (await send('/api/conversations', 'ka', { user: 'user-2' })).json()) as {
      total: number;
    };
    expect(list.total).toBe(0);
  });

  it('refuses unauthenticated callers, callers without a tenant, and bad input', async () => {
    const { send } = setup();

    expect((await send('/api/conversations')).status).toBe(401);
    expect((await send('/api/conversations', 'homeless')).status).toBe(403);
    const noAgent = await send('/api/conversations', 'ka', { method: 'POST', user: 'u', body: {} });
    expect(noAgent.status).toBe(400);
    expect(await noAgent.json()).toMatchObject({
      available: [AGENT, 'kunnskapsassistenten-retrieve-only__default'],
    });
    expect(
      (
        await send('/api/conversations', 'ka', {
          method: 'POST',
          user: 'u',
          body: { 'agent-id': 'no/such' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send('/api/conversations', 'ka', {
          method: 'POST',
          user: 'u',
          body: { 'agent-id': AGENT, tags: [''] },
        })
      ).status,
    ).toBe(400);
  });

  it('includes stored diagnostics only when asked', async () => {
    const { send, store } = setup();
    const { json } = await create(send, 'kari');
    await store.append(
      { tenant: '991825827', user: 'https://ansattporten.no|kari' },
      json.conversation.id,
      {
        role: 'assistant',
        text: 'Svar [1]',
        chunks: [
          { chunkId: 'c1', docTitle: 'Tildelingsbrev', docNum: 'd1', contentMarkdown: 'tekst' },
        ],
        diagnostics: { steps: 3 },
      },
    );

    type Detail = { messages: { diagnostics?: unknown; chunks: unknown[] }[] };
    const plain = (await (
      await send(`/api/conversations/${json.conversation.id}`, 'kari')
    ).json()) as Detail;
    const withDiagnostics = (await (
      await send(`/api/conversations/${json.conversation.id}?include_diagnostics=true`, 'kari')
    ).json()) as Detail;

    expect(plain.messages.at(-1)?.diagnostics).toBeUndefined();
    expect(plain.messages.at(-1)?.chunks).toEqual([
      { chunkId: 'c1', docTitle: 'Tildelingsbrev', docNum: 'd1', contentMarkdown: 'tekst' },
    ]);
    expect(withDiagnostics.messages.at(-1)?.diagnostics).toEqual({ steps: 3 });
  });
});

describe('conversation routes for frontends', () => {
  const messagesOf = async (send: ReturnType<typeof setup>['send'], id: string, query = '') =>
    (
      (await (await send(`/api/conversations/${id}${query}`, 'ka', { user: 'u' })).json()) as {
        messages: { role: string | null; text: string; input?: unknown }[];
      }
    ).messages;

  it('never returns the stored system prompt, on the active branch or with branches=all', async () => {
    const { send, store } = setup();
    const { json } = await create(send, 'ka', 'u');
    const owner = { tenant: '991825827', user: 'legacy-api-key|key-ka#u' };
    await store.append(owner, json.conversation.id, { role: 'user', text: 'hei' });

    const stored = await store.messages(owner, json.conversation.id);
    const active = await messagesOf(send, json.conversation.id);
    const all = await messagesOf(send, json.conversation.id, '?branches=all');

    expect(stored?.some((m) => m.role === 'system')).toBe(true);
    expect([...active, ...all].some((m) => m.role === 'system')).toBe(false);
    expect(JSON.stringify([active, all])).not.toContain('helpful assistant');
  });

  it('returns the form input stored with the user message', async () => {
    const { send, store } = setup();
    const { json } = await create(send, 'ka', 'u');
    const owner = { tenant: '991825827', user: 'legacy-api-key|key-ka#u' };
    await store.append(owner, json.conversation.id, {
      role: 'user',
      text: 'Departement: KD',
      input: { ministry: 'KD' },
    });

    const messages = await messagesOf(send, json.conversation.id);

    expect(messages.find((m) => m.role === 'user')?.input).toEqual({ ministry: 'KD' });
  });

  it.each(['title', 'topic'])('renames a conversation with the key %s', async (key) => {
    const { send } = setup();
    const { json } = await create(send, 'ka', 'u');

    const renamed = await send(`/api/conversations/${json.conversation.id}`, 'ka', {
      method: 'PUT',
      user: 'u',
      body: { [key]: 'Nytt navn' },
    });

    expect(await renamed.json()).toMatchObject({ conversation: { topic: 'Nytt navn' } });
  });

  it('refuses an unknown key when renaming with 400 unknown_field instead of ignoring it', async () => {
    const { send } = setup();
    const { json } = await create(send, 'ka', 'u');

    const refused = await send(`/api/conversations/${json.conversation.id}`, 'ka', {
      method: 'PUT',
      user: 'u',
      body: { name: 'Nytt navn' },
    });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      code: 'unknown_field',
      status: 400,
      title: 'Unknown field: name',
    });
  });

  it('answers errors as problem+json that also keeps the legacy error text', async () => {
    const { send } = setup();

    const missing = await send('/api/conversations/nope', 'ka', { user: 'u' });
    const anonymous = await send('/api/conversations');

    expect(missing.headers.get('content-type')).toContain('application/problem+json');
    expect(await missing.json()).toEqual({
      error: 'Conversation not found',
      type: 'about:blank',
      title: 'Conversation not found',
      status: 404,
      detail: 'Conversation not found',
      code: 'conversation_not_found',
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ error: 'Unauthorized', code: 'unauthorized' });
  });
});

describe('in-memory conversation store', () => {
  it('keeps messages in order even when appended within the same millisecond', async () => {
    const store = new InMemoryConversationStore(() => 5);
    const owner = { tenant: '991825827', user: 'u' };
    const conversation = await store.create(owner, { agentId: AGENT, userId: 'u' });
    await store.append(owner, conversation.id, { role: 'user', text: 'a' });
    await store.append(owner, conversation.id, { role: 'assistant', text: 'b' });

    const messages = await store.messages(owner, conversation.id);
    const created = messages?.map((m) => m.created) ?? [];
    expect(messages?.map((m) => m.text)).toEqual(['You are a helpful assistant.', 'a', 'b']);
    expect([...created].sort((x, y) => x - y)).toEqual(created);
    expect(new Set(created).size).toBe(created.length);
    expect(
      await store.append({ ...owner, user: 'v' }, conversation.id, { text: 'x' }),
    ).toBeUndefined();
  });
});

describe('conversation branches', () => {
  const owner = { tenant: '991825827', user: 'u' };
  const tree = async (store: ConversationStore, who: Owner = owner) => {
    const conversation = await store.create(who, { agentId: AGENT, userId: 'u' });
    const root = (await store.messages(who, conversation.id))?.[0];
    await store.append(who, conversation.id, { role: 'user', text: 'first' });
    await store.append(who, conversation.id, { role: 'assistant', text: 'first answer' });
    const q2 = await store.append(who, conversation.id, {
      role: 'user',
      text: 'reworded',
      parentId: root?.id ?? '',
    });
    await store.append(who, conversation.id, {
      role: 'assistant',
      text: 'new answer',
      parentId: q2?.id ?? '',
    });
    return conversation.id;
  };

  it('lists the branch that holds the newest message by default and every message with branches=all', async () => {
    const { send, store } = setup();
    const id = await tree(store, { tenant: owner.tenant, user: 'legacy-api-key|key-ka#u' });

    const active = (await (await send(`/api/conversations/${id}`, 'ka', { user: 'u' })).json()) as {
      messages: { text: string }[];
    };
    const all = (await (
      await send(`/api/conversations/${id}?branches=all`, 'ka', { user: 'u' })
    ).json()) as { messages: { text: string }[] };

    expect(active.messages.map((m) => m.text)).toEqual(['reworded', 'new answer']);
    expect(all.messages.map((m) => m.text)).toEqual([
      'first',
      'first answer',
      'reworded',
      'new answer',
    ]);
  });

  it('appends under the active branch and to a named parent when one is given', async () => {
    const store = new InMemoryConversationStore();
    const id = await tree(store);
    const before = (await store.messages(owner, id)) ?? [];
    const firstAnswer = before.find((m) => m.text === 'first answer');

    const onActive = await store.append(owner, id, { role: 'user', text: 'follow-up' });
    const onOther = await store.append(owner, id, {
      role: 'user',
      text: 'other follow-up',
      parentId: firstAnswer?.id ?? '',
    });

    expect(onActive?.parentId).toBe(before.find((m) => m.text === 'new answer')?.id);
    expect(onOther?.parentId).toBe(firstAnswer?.id);
    await expect(store.append(owner, id, { text: 'x', parentId: 'nope' })).rejects.toThrow(
      'no message nope',
    );
  });

  it('gives the model the active branch as history', async () => {
    const store = new InMemoryConversationStore();
    const turns = conversationTurns(
      store,
      async () => ({
        principal: { kind: 'employee', issuer: 'i', subject: 'u', tenant: owner.tenant },
      }),
      () => 'id',
    );
    const id = await tree(store, { tenant: owner.tenant, user: 'i|u' });

    const opened = await turns.open(new Request('http://x'), {
      conversationId: id,
      agentId: AGENT,
    });

    expect(opened.ok && opened.history.map((h) => h.text)).toEqual(['reworded', 'new answer']);
  });
});
