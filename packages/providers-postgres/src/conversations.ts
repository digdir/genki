import { createHash } from 'node:crypto';
import {
  activeLeaf,
  defaultTopic,
  hasTags,
  nanoId,
  normalizeTags,
  seedMessages,
  type Conversation,
  type ConversationStore,
  type Message,
  type NewConversation,
  type NewMessage,
  type Owner,
  type Page,
} from '@genai/conversations';
import type { Pool, PoolClient } from 'pg';
import { open, seal } from './crypto.js';
import type { ContentKeys } from './keys.js';
import { withTenant } from './tenancy.js';

interface ConversationRow {
  id: string;
  tenant: string;
  owner_hash: string;
  agent_id: string;
  tags: string[];
  created: string;
  body: Buffer;
}

interface MessageRow {
  seq: number;
  created: string;
  parent_seq: number | null;
  body: Buffer;
}

const rootParent = -1;

const parentSeqOf = (row: Pick<MessageRow, 'seq' | 'parent_seq'>) =>
  row.parent_seq === null ? row.seq - 1 : row.parent_seq;

export const threadScope = (conversation: string) => `thread:${conversation}`;

const seqOf = (id: string) => Number(id.slice(id.lastIndexOf('.') + 1));

const hashOwner = (owner: Owner) =>
  createHash('sha256').update(`${owner.tenant}\u0000${owner.user}`).digest('hex');

export class PostgresConversationStore implements ConversationStore {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async create(owner: Owner, input: NewConversation): Promise<Conversation> {
    const id = nanoId();
    const created = this.now();
    const key = await this.#key(owner.tenant, id, true);
    const tags = normalizeTags(input.tags);
    const topic = input.topic ?? defaultTopic;
    await withTenant(this.pool, owner.tenant, async (client) => {
      await client.query(
        `insert into conversations (id, tenant, owner_hash, agent_id, tags, created, body)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          owner.tenant,
          hashOwner(owner),
          input.agentId,
          JSON.stringify(tags),
          created,
          seal(
            key,
            Buffer.from(JSON.stringify({ topic, userId: input.userId })),
            `conversation:${id}`,
          ),
        ],
      );
      let seq = 0;
      for (const message of seedMessages(input.filterValue)) {
        await this.#insertMessage(
          client,
          key,
          owner.tenant,
          id,
          seq,
          created + seq,
          message,
          seq - 1,
        );
        seq += 1;
      }
    });
    return {
      id,
      tenant: owner.tenant,
      owner: owner.user,
      userId: input.userId,
      agentId: input.agentId,
      topic,
      tags,
      created,
    };
  }

  async list(owner: Owner, page: Page) {
    return withTenant(this.pool, owner.tenant, async (client) => {
      const tags = normalizeTags(page.tags);
      const filter = `tenant = $1 and owner_hash = $2 and tags @> $3::jsonb`;
      const params = [owner.tenant, hashOwner(owner), JSON.stringify(tags)];
      const total = await client.query<{ count: string }>(
        `select count(*) from conversations where ${filter}`,
        params,
      );
      const rows = await client.query<ConversationRow>(
        `select * from conversations where ${filter} order by created desc, id limit $4 offset $5`,
        [...params, page.pageSize, page.pageSize * page.pageIndex],
      );
      const conversations = await Promise.all(rows.rows.map((r) => this.#decode(r, owner)));
      return {
        conversations: conversations.filter((c) => hasTags(c, tags)),
        total: Number(total.rows[0]?.count ?? 0),
      };
    });
  }

  async get(owner: Owner, id: string) {
    return withTenant(this.pool, owner.tenant, async (client) => {
      const row = await this.#find(client, owner, id);
      return row && this.#decode(row, owner);
    });
  }

  async messages(owner: Owner, id: string) {
    return withTenant(this.pool, owner.tenant, async (client) => {
      if (!(await this.#find(client, owner, id))) return undefined;
      const key = await this.#key(owner.tenant, id, false);
      const rows = await client.query<MessageRow>(
        'select seq, created, parent_seq, body from conversation_messages where conversation = $1 and tenant = $2 order by seq',
        [id, owner.tenant],
      );
      return rows.rows.map((row) => this.#decodeMessage(key, id, row));
    });
  }

  async update(owner: Owner, id: string, changes: { topic?: string; tags?: string[] }) {
    return withTenant(this.pool, owner.tenant, async (client) => {
      const row = await this.#find(client, owner, id, true);
      if (!row) return undefined;
      const current = await this.#decode(row, owner);
      const next = {
        ...current,
        ...(changes.topic === undefined ? {} : { topic: changes.topic }),
        ...(changes.tags === undefined ? {} : { tags: normalizeTags(changes.tags) }),
      };
      const key = await this.#key(owner.tenant, id, true);
      await client.query(
        'update conversations set tags = $3, body = $4 where id = $1 and tenant = $2',
        [
          id,
          owner.tenant,
          JSON.stringify(next.tags),
          seal(
            key,
            Buffer.from(JSON.stringify({ topic: next.topic, userId: next.userId })),
            `conversation:${id}`,
          ),
        ],
      );
      return next;
    });
  }

  async append(owner: Owner, id: string, message: NewMessage) {
    return withTenant(this.pool, owner.tenant, async (client) => {
      if (!(await this.#find(client, owner, id, true))) return undefined;
      const last = await client.query<{ seq: number; created: string }>(
        'select seq, created from conversation_messages where conversation = $1 order by seq desc limit 1',
        [id],
      );
      const seq = (last.rows[0]?.seq ?? -1) + 1;
      const created = Math.max(this.now(), Number(last.rows[0]?.created ?? 0) + 1);
      const key = await this.#key(owner.tenant, id, true);
      const parentSeq = await this.#parentFor(client, id, message);
      return this.#insertMessage(client, key, owner.tenant, id, seq, created, message, parentSeq);
    });
  }

  async delete(owner: Owner, id: string) {
    const deleted = await withTenant(this.pool, owner.tenant, async (client) => {
      const result = await client.query(
        'delete from conversations where id = $1 and tenant = $2 and owner_hash = $3',
        [id, owner.tenant, hashOwner(owner)],
      );
      return (result.rowCount ?? 0) > 0;
    });
    if (deleted) await this.keys.erase(owner.tenant, threadScope(id));
    return deleted;
  }

  async #key(tenant: string, id: string, create: true): Promise<Buffer>;
  async #key(tenant: string, id: string, create: false): Promise<Buffer | undefined>;
  async #key(tenant: string, id: string, create: boolean) {
    const key = await this.keys.get(tenant, threadScope(id), create);
    if (create && !key) throw new Error('no content key');
    return key;
  }

  async #find(client: PoolClient, owner: Owner, id: string, lock = false) {
    const found = await client.query<ConversationRow>(
      `select * from conversations where id = $1 and tenant = $2 and owner_hash = $3${lock ? ' for update' : ''}`,
      [id, owner.tenant, hashOwner(owner)],
    );
    return found.rows[0];
  }

  async #parentFor(client: PoolClient, conversation: string, message: NewMessage) {
    const rows = await client.query<Pick<MessageRow, 'seq' | 'created' | 'parent_seq'>>(
      'select seq, created, parent_seq from conversation_messages where conversation = $1 order by seq',
      [conversation],
    );
    const nodes = rows.rows.map((row) => {
      const parentSeq = parentSeqOf(row);
      return {
        id: `${conversation}.${row.seq}`,
        created: Number(row.created),
        ...(parentSeq < 0 ? {} : { parentId: `${conversation}.${parentSeq}` }),
      };
    });
    const parentId = message.parentId ?? activeLeaf(nodes)?.id;
    if (parentId === undefined) return rootParent;
    if (!nodes.some((n) => n.id === parentId))
      throw new Error(`no message ${parentId} in the conversation`);
    return seqOf(parentId);
  }

  async #decode(row: ConversationRow, owner: Owner): Promise<Conversation> {
    const key = await this.#key(row.tenant, row.id, false);
    let body = { topic: '', userId: '' };
    if (key) {
      try {
        body = JSON.parse(open(key, row.body, `conversation:${row.id}`).toString()) as typeof body;
      } catch {
        body = { topic: '', userId: '' };
      }
    }
    return {
      id: row.id,
      tenant: row.tenant,
      owner: owner.user,
      userId: body.userId,
      agentId: row.agent_id,
      topic: body.topic,
      tags: row.tags,
      created: Number(row.created),
    };
  }

  #decodeMessage(key: Buffer | undefined, conversation: string, row: MessageRow): Message {
    const id = `${conversation}.${row.seq}`;
    const parentSeq = parentSeqOf(row);
    const parent = parentSeq < 0 ? {} : { parentId: `${conversation}.${parentSeq}` };
    const erased: Message = {
      id,
      text: '',
      created: Number(row.created),
      tags: [],
      chunks: [],
      ...parent,
    };
    if (!key) return erased;
    try {
      const body = JSON.parse(open(key, row.body, `message:${id}`).toString()) as Omit<
        Message,
        'created' | 'parentId'
      >;
      return { ...body, created: Number(row.created), ...parent };
    } catch {
      return erased;
    }
  }

  async #insertMessage(
    client: PoolClient,
    key: Buffer,
    tenant: string,
    conversation: string,
    seq: number,
    created: number,
    input: NewMessage,
    parentSeq: number,
  ): Promise<Message> {
    const id = `${conversation}.${seq}`;
    const body: Omit<Message, 'created' | 'parentId'> = {
      id,
      ...(input.role === undefined ? {} : { role: input.role }),
      text: input.text,
      tags: normalizeTags(input.tags),
      ...(input.filterValue === undefined ? {} : { filterValue: input.filterValue }),
      chunks: input.chunks ?? [],
      ...(input.sources?.length ? { sources: input.sources } : {}),
      ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.input ? { input: input.input } : {}),
    };
    await client.query(
      `insert into conversation_messages (conversation, seq, tenant, created, parent_seq, body)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        conversation,
        seq,
        tenant,
        created,
        parentSeq,
        seal(key, Buffer.from(JSON.stringify(body)), `message:${id}`),
      ],
    );
    return {
      ...body,
      created,
      ...(parentSeq < 0 ? {} : { parentId: `${conversation}.${parentSeq}` }),
    };
  }
}
