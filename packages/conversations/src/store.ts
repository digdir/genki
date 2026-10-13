import { randomBytes } from 'node:crypto';
import { activeLeaf } from './branches.js';

export interface Owner {
  tenant: string;
  user: string;
}

export interface Conversation {
  id: string;
  tenant: string;
  owner: string;
  userId: string;
  agentId: string;
  topic: string;
  tags: string[];
  created: number;
}

export interface MessageChunk {
  chunkId: string;
  docTitle: string;
  docNum?: string;
  contentMarkdown: string;
}

export interface MessageSource {
  index?: number;
  title: string;
  url?: string;
  document_id?: string;
  excerpts: { chunk_id: string; text: string; position?: number }[];
}

export interface Message {
  id: string;
  role?: string;
  text: string;
  created: number;
  tags: string[];
  filterValue?: unknown;
  chunks: MessageChunk[];
  sources?: MessageSource[];
  diagnostics?: unknown;
  parentId?: string;
  task?: string;
  attachments?: string[];
  input?: Record<string, unknown>;
}

export interface NewConversation {
  agentId: string;
  userId: string;
  topic?: string;
  tags?: string[];
  filterValue?: unknown;
}

export interface NewMessage {
  role?: string;
  text: string;
  tags?: string[];
  filterValue?: unknown;
  chunks?: MessageChunk[];
  sources?: MessageSource[];
  diagnostics?: unknown;
  parentId?: string;
  task?: string;
  attachments?: string[];
  input?: Record<string, unknown>;
}

export interface Page {
  pageSize: number;
  pageIndex: number;
  tags?: string[];
}

export interface ConversationStore {
  create(owner: Owner, input: NewConversation): Promise<Conversation>;
  list(owner: Owner, page: Page): Promise<{ conversations: Conversation[]; total: number }>;
  get(owner: Owner, id: string): Promise<Conversation | undefined>;
  messages(owner: Owner, id: string): Promise<Message[] | undefined>;
  update(
    owner: Owner,
    id: string,
    changes: { topic?: string; tags?: string[] },
  ): Promise<Conversation | undefined>;
  append(owner: Owner, id: string, message: NewMessage): Promise<Message | undefined>;
  delete(owner: Owner, id: string): Promise<boolean>;
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export const nanoId = () => [...randomBytes(21)].map((b) => alphabet[b & 63]).join('');

export const normalizeTags = (tags: unknown): string[] => {
  const list = tags === undefined || tags === null ? [] : Array.isArray(tags) ? tags : [tags];
  return [
    ...new Set(
      list
        .map((t) => (t === null || t === undefined ? '' : String(t).trim()))
        .filter((t) => t.length > 0),
    ),
  ];
};

export const hasTags = (conversation: { tags: string[] }, required: string[] = []) =>
  required.every((t) => conversation.tags.includes(t));

export const defaultTopic = 'Ny tråd';

export const seedMessages = (filterValue: unknown): NewMessage[] => [
  { role: 'system', text: 'You are a helpful assistant.' },
  ...(filterValue === undefined || filterValue === null ? [] : [{ text: '', filterValue }]),
];

export class InMemoryConversationStore implements ConversationStore {
  readonly #conversations = new Map<string, Conversation>();
  readonly #messages = new Map<string, Message[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async create(owner: Owner, input: NewConversation): Promise<Conversation> {
    const created = this.now();
    const conversation: Conversation = {
      id: nanoId(),
      tenant: owner.tenant,
      owner: owner.user,
      userId: input.userId,
      agentId: input.agentId,
      topic: input.topic ?? defaultTopic,
      tags: normalizeTags(input.tags),
      created,
    };
    this.#conversations.set(conversation.id, conversation);
    const seeded: Message[] = [];
    for (const [i, seed] of seedMessages(input.filterValue).entries())
      seeded.push(this.#message(seed, created + i, seeded.at(-1)?.id));
    this.#messages.set(conversation.id, seeded);
    return structuredClone(conversation);
  }

  async list(owner: Owner, page: Page) {
    const mine = [...this.#conversations.values()]
      .filter((c) => this.#owns(owner, c) && hasTags(c, page.tags))
      .sort((a, b) => b.created - a.created);
    const start = page.pageSize * page.pageIndex;
    return {
      conversations: structuredClone(mine.slice(start, start + page.pageSize)),
      total: mine.length,
    };
  }

  async get(owner: Owner, id: string) {
    const found = this.#find(owner, id);
    return found && structuredClone(found);
  }

  async messages(owner: Owner, id: string) {
    if (!this.#find(owner, id)) return undefined;
    return structuredClone(this.#messages.get(id) ?? []);
  }

  async update(owner: Owner, id: string, changes: { topic?: string; tags?: string[] }) {
    const found = this.#find(owner, id);
    if (!found) return undefined;
    if (changes.topic !== undefined) found.topic = changes.topic;
    if (changes.tags !== undefined) found.tags = normalizeTags(changes.tags);
    return structuredClone(found);
  }

  async append(owner: Owner, id: string, message: NewMessage) {
    if (!this.#find(owner, id)) return undefined;
    const list = this.#messages.get(id) ?? [];
    const last = list.at(-1)?.created ?? 0;
    const parentId = message.parentId ?? activeLeaf(list)?.id;
    if (parentId !== undefined && !list.some((m) => m.id === parentId))
      throw new Error(`no message ${parentId} in the conversation`);
    const stored = this.#message(message, Math.max(this.now(), last + 1), parentId);
    list.push(stored);
    this.#messages.set(id, list);
    return structuredClone(stored);
  }

  async delete(owner: Owner, id: string) {
    if (!this.#find(owner, id)) return false;
    this.#conversations.delete(id);
    this.#messages.delete(id);
    return true;
  }

  #owns(owner: Owner, c: Conversation) {
    return c.tenant === owner.tenant && c.owner === owner.user;
  }

  #find(owner: Owner, id: string) {
    const found = this.#conversations.get(id);
    return found && this.#owns(owner, found) ? found : undefined;
  }

  #message(input: NewMessage, created: number, parentId?: string): Message {
    return {
      id: nanoId(),
      ...(input.role === undefined ? {} : { role: input.role }),
      text: input.text,
      created,
      tags: normalizeTags(input.tags),
      ...(input.filterValue === undefined ? {} : { filterValue: input.filterValue }),
      chunks: input.chunks ?? [],
      ...(input.sources?.length ? { sources: input.sources } : {}),
      ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.input ? { input: input.input } : {}),
      ...(parentId === undefined ? {} : { parentId }),
    };
  }
}
