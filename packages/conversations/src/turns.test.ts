import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryConversationStore } from './store.js';
import { conversationTurns } from './turns.js';
import { userKey } from './routes.js';

const key: Principal = {
  kind: 'agency-system',
  issuer: 'api-key',
  subject: 'ka-key',
  tenant: '991825827',
};

const request = (headers: Record<string, string> = {}) =>
  new Request('http://x/api/mcp', { method: 'POST', headers });

describe('conversation turns for MCP', () => {
  it('owns a frontend-bound key conversation by X-User-Id, the same owner the REST routes use', async () => {
    const store = new InMemoryConversationStore();
    const turns = conversationTurns(
      store,
      async () => ({ principal: key, externalUsers: true }),
      () => 'n',
    );

    const opened = await turns.open(request({ 'x-user-id': 'ola' }), { agentId: 'a' });
    if (!opened.ok) throw new Error('not opened');

    const owner = { tenant: '991825827', user: `${userKey(key)}#ola` };
    expect((await store.get(owner, opened.id))?.userId).toBe('ola');
  });

  it('falls back to the key itself when a bound key sends no X-User-Id', async () => {
    const store = new InMemoryConversationStore();
    const turns = conversationTurns(
      store,
      async () => ({ principal: key, externalUsers: true }),
      () => 'n',
    );

    const opened = await turns.open(request(), { agentId: 'a' });
    if (!opened.ok) throw new Error('not opened');

    expect(await store.get({ tenant: '991825827', user: userKey(key) }, opened.id)).toBeDefined();
  });

  it('ignores X-User-Id from a key not bound to a service', async () => {
    const store = new InMemoryConversationStore();
    const turns = conversationTurns(
      store,
      async () => ({ principal: key }),
      () => 'n',
    );

    const opened = await turns.open(request({ 'x-user-id': 'ola' }), { agentId: 'a' });
    if (!opened.ok) throw new Error('not opened');

    expect(await store.get({ tenant: '991825827', user: userKey(key) }, opened.id)).toBeDefined();
  });

  it('returns the stored user and assistant turns as history, without system or blank messages', async () => {
    const store = new InMemoryConversationStore();
    const turns = conversationTurns(
      store,
      async () => ({ principal: key }),
      () => 'n',
    );
    const opened = await turns.open(request(), { agentId: 'a' });
    if (!opened.ok) throw new Error('not opened');
    await turns.append(request(), opened.id, { role: 'user', text: 'Spørsmål' });
    await turns.append(request(), opened.id, { role: 'assistant', text: '' });
    await turns.append(request(), opened.id, { role: 'assistant', text: 'Svar' });

    const again = await turns.open(request(), { conversationId: opened.id, agentId: 'a' });

    expect(again).toEqual({
      ok: true,
      id: opened.id,
      history: [
        { role: 'user', text: 'Spørsmål' },
        { role: 'assistant', text: 'Svar' },
      ],
    });
  });

  it("answers conversation_not_found for another caller's conversation", async () => {
    const store = new InMemoryConversationStore();
    const mine = conversationTurns(
      store,
      async () => ({ principal: key }),
      () => 'n',
    );
    const theirs = conversationTurns(
      store,
      async () => ({ principal: { ...key, subject: 'other' } }),
      () => 'n',
    );
    const opened = await mine.open(request(), { agentId: 'a' });
    if (!opened.ok) throw new Error('not opened');

    expect(await theirs.open(request(), { conversationId: opened.id, agentId: 'a' })).toMatchObject(
      {
        ok: false,
        code: 'conversation_not_found',
      },
    );
  });
});
