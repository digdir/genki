import { activeBranch } from './branches.js';
import { userKey, type ConversationCaller } from './routes.js';
import { defaultTopic, type ConversationStore, type NewMessage, type Owner } from './store.js';

export interface PriorTurn {
  role: 'user' | 'assistant';
  text: string;
}

export type OpenedTurns =
  { ok: true; id: string; history: PriorTurn[] } | { ok: false; code: string; message: string };

export interface ConversationTurns {
  open(request: Request, input: { conversationId?: string; agentId: string }): Promise<OpenedTurns>;
  append(request: Request, conversationId: string, message: NewMessage): Promise<void>;
  discard(request: Request, conversationId: string): Promise<void>;
}

const turnOwner = (
  caller: ConversationCaller,
  request: Request,
): { owner: Owner; userId: string } | undefined => {
  const tenant = caller.principal.tenant;
  if (!tenant) return undefined;
  const user = userKey(caller.principal);
  const external = caller.externalUsers ? request.headers.get('x-user-id')?.trim() : undefined;
  return external
    ? { owner: { tenant, user: `${user}#${external}` }, userId: external }
    : { owner: { tenant, user }, userId: caller.principal.subject };
};

const maxTitle = 60;

export const titleOf = (text: string) => {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > maxTitle ? `${line.slice(0, maxTitle - 1).trimEnd()}…` : line;
};

export const conversationTurns = (
  store: ConversationStore,
  callerOf: (request: Request) => Promise<ConversationCaller | undefined>,
  newId: () => string,
): ConversationTurns => {
  const ownerFor = async (request: Request) => {
    const caller = await callerOf(request);
    return caller && turnOwner(caller, request);
  };
  return {
    open: async (request, { conversationId, agentId }) => {
      const found = await ownerFor(request);
      if (!found) return { ok: true, id: conversationId ?? newId(), history: [] };
      if (!conversationId) {
        const created = await store.create(found.owner, { agentId, userId: found.userId });
        return { ok: true, id: created.id, history: [] };
      }
      const messages = await store.messages(found.owner, conversationId);
      if (!messages)
        return {
          ok: false,
          code: 'conversation_not_found',
          message: `Conversation not found: ${conversationId}`,
        };
      return {
        ok: true,
        id: conversationId,
        history: activeBranch(messages).flatMap((m): PriorTurn[] =>
          (m.role === 'user' || m.role === 'assistant') && m.text.trim() !== ''
            ? [{ role: m.role, text: m.text }]
            : [],
        ),
      };
    },
    append: async (request, conversationId, message) => {
      const found = await ownerFor(request);
      if (!found) return;
      await store.append(found.owner, conversationId, message);
      const title = message.role === 'user' ? titleOf(message.text) : '';
      if (title === '') return;
      const conversation = await store.get(found.owner, conversationId);
      if (conversation?.topic === defaultTopic)
        await store.update(found.owner, conversationId, { topic: title });
    },
    discard: async (request, conversationId) => {
      const found = await ownerFor(request);
      if (found) await store.delete(found.owner, conversationId);
    },
  };
};
