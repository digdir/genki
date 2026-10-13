import type { JSONSchema, Part } from '@genai/contracts';
import type { PortContext, SecretResolver } from '@genai/kernel';
import {
  errorResult,
  ToolError,
  type Source,
  type ToolPort,
  type ToolResult,
} from '@genai/port-tools';
import {
  EgressError,
  EgressGuard,
  PinnedToolSource,
  TenantSecrets,
  toolSlug,
  type ConnectionRegistry,
  type ConnectionState,
  type PinnedTool,
} from '@genai/providers-mcp-client';
import {
  A2aClient,
  type AgentCard,
  type RemoteMessage,
  type RemotePart,
  type RemoteTask,
} from './client.js';

export const inputSchemaExtension = 'urn:genai:a2a:input-schema:v1';
const SOURCES_MIME = 'application/vnd.genai.sources+json';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const dataSchemaOf = (card: AgentCard): JSONSchema | undefined => {
  const extension = card.capabilities?.extensions?.find((e) => e.uri === inputSchemaExtension);
  const schema = extension?.params?.schema;
  return isRecord(schema) ? schema : undefined;
};

export const toolInput = (card: AgentCard): JSONSchema => {
  const data = dataSchemaOf(card);
  return {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'What to ask the agent, in plain text.' },
      ...(data
        ? { data: { ...data, description: 'Structured input the agent reads beside the text.' } }
        : {}),
      context_id: {
        type: 'string',
        description: 'Pass the context_id from an earlier answer to continue that conversation.',
      },
      task_id: {
        type: 'string',
        description: 'Pass the task_id when the agent asked for more input on that task.',
      },
    },
    required: [
      'message',
      ...(data && Array.isArray(data.required) && data.required.length ? ['data'] : []),
    ],
  };
};

export const pinnedFromCard = (connectionId: string, card: AgentCard): PinnedTool[] => {
  const input = toolInput(card);
  const skills = card.skills?.filter((s) => isRecord(s) && typeof s.id === 'string') ?? [];
  if (skills.length === 0)
    return [
      {
        remoteName: '',
        name: `${connectionId}.${toolSlug(card.name)}`,
        description: card.description,
        input,
      },
    ];
  return skills.map((skill) => ({
    remoteName: skill.id,
    name: `${connectionId}.${toolSlug(skill.id)}`,
    description: [card.name, skill.description ?? skill.name ?? '']
      .filter((s) => s.trim() !== '')
      .join(': '),
    input,
    call: { skill: skill.id },
  }));
};

const finished = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);
const waiting = new Set(['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);

const isTask = (v: RemoteTask | RemoteMessage): v is RemoteTask =>
  typeof (v as RemoteTask).id === 'string' && isRecord((v as RemoteTask).status);

const sourcesOf = (parts: RemotePart[]): Source[] =>
  parts.flatMap((p) => {
    if (p.mediaType !== SOURCES_MIME || !isRecord(p.data) || !Array.isArray(p.data.sources))
      return [];
    return (p.data.sources as unknown[]).filter(isRecord).flatMap((s): Source[] => {
      const id = typeof s.chunkId === 'string' ? s.chunkId : typeof s.id === 'string' ? s.id : '';
      if (!id) return [];
      return [
        {
          id,
          ...(typeof s.title === 'string' ? { title: s.title } : {}),
          ...(typeof s.url === 'string' && /^https:\/\//.test(s.url) ? { url: s.url } : {}),
          ...(typeof s.text === 'string' ? { text: s.text } : {}),
        },
      ];
    });
  });

export const toToolResult = (
  connectionId: string,
  answer: RemoteTask | RemoteMessage,
): ToolResult => {
  const meta = { untrusted: true, source: `a2a:${connectionId}` };
  const task = isTask(answer) ? answer : undefined;
  const state = task?.status?.state ?? 'TASK_STATE_COMPLETED';
  const remote: RemotePart[] = task
    ? [
        ...(task.artifacts ?? []).flatMap((a) => a.parts ?? []),
        ...(state === 'TASK_STATE_COMPLETED' ? [] : (task.status?.message?.parts ?? [])),
      ]
    : ((answer as RemoteMessage).parts ?? []);
  const parts: Part[] = [];
  for (const p of remote) {
    if (typeof p.text === 'string')
      parts.push({ mime: 'text/plain', body: { kind: 'text', text: p.text }, meta });
    else if (p.data !== undefined && p.mediaType !== SOURCES_MIME)
      parts.push({ mime: 'application/json', body: { kind: 'json', json: p.data }, meta });
  }
  const contextId = task?.contextId ?? (answer as RemoteMessage).contextId;
  parts.push({
    mime: 'application/json',
    body: {
      kind: 'json',
      json: {
        state: state.replace('TASK_STATE_', '').toLowerCase().replaceAll('_', '-'),
        ...(task ? { task_id: task.id } : {}),
        ...(contextId ? { context_id: contextId } : {}),
      },
    },
    meta,
  });
  const sources = sourcesOf(remote);
  const failed =
    state === 'TASK_STATE_FAILED' ||
    state === 'TASK_STATE_REJECTED' ||
    state === 'TASK_STATE_CANCELED';
  return {
    parts,
    ...(sources.length ? { sources } : {}),
    ...(failed ? { isError: true } : {}),
  };
};

export interface A2aToolSourceOptions {
  registry: ConnectionRegistry;
  secrets: SecretResolver;
  guard?: EgressGuard;
  pollMs?: number;
}

export class A2aToolSource extends PinnedToolSource {
  readonly protocol = 'a2a' as const;
  readonly #guard: EgressGuard;
  readonly #secrets: TenantSecrets;
  readonly #clients = new Map<string, A2aClient>();
  readonly #pollMs: number;

  constructor(options: A2aToolSourceOptions) {
    super(options.registry);
    this.#guard = options.guard ?? new EgressGuard();
    this.#secrets = new TenantSecrets(options.secrets);
    this.#pollMs = options.pollMs ?? 500;
  }

  #client(state: ConnectionState) {
    const key = this.key(state.connection.tenant, state.connection.id);
    let client = this.#clients.get(key);
    if (!client) {
      client = new A2aClient(state.connection, this.#guard, this.#secrets);
      this.#clients.set(key, client);
    }
    return client;
  }

  protected async listTools(state: ConnectionState, signal?: AbortSignal) {
    return pinnedFromCard(state.connection.id, await this.#client(state).card(signal));
  }

  protected port(
    state: ConnectionState,
    tool: PinnedTool,
    ctx: PortContext,
    version: string,
  ): ToolPort {
    const client = this.#client(state);
    const connectionId = state.connection.id;
    const deadline = state.connection.timeoutMs ?? 30_000;
    return {
      definition: () => ({
        name: tool.name,
        version,
        description: tool.description,
        input: tool.input,
        origin: 'a2a',
      }),
      call: async (input) => {
        if (!isRecord(input) || typeof input.message !== 'string' || input.message.trim() === '')
          return errorResult(`Invalid input for ${tool.name}: \`message\` is required`);
        if (input.data !== undefined && !isRecord(input.data))
          return errorResult(`Invalid input for ${tool.name}: \`data\` must be an object`);
        if (ctx.signal.aborted) throw new ToolError('cancelled', 'the tool call was cancelled');
        await ctx.meter({ requests: 1 });
        try {
          let answer = await client.send(
            {
              text: input.message,
              ...(isRecord(input.data) ? { data: input.data } : {}),
              ...(typeof input.context_id === 'string' ? { contextId: input.context_id } : {}),
              ...(typeof input.task_id === 'string' ? { taskId: input.task_id } : {}),
              ...(typeof tool.call?.skill === 'string'
                ? { metadata: { skillId: tool.call.skill } }
                : {}),
            },
            ctx.signal,
          );
          const started = Date.now();
          while (
            isTask(answer) &&
            !finished.has(answer.status?.state ?? '') &&
            !waiting.has(answer.status?.state ?? '') &&
            Date.now() - started < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
            if (ctx.signal.aborted) throw new ToolError('cancelled', 'the tool call was cancelled');
            answer = await client.task(answer.id, ctx.signal);
          }
          return toToolResult(connectionId, answer);
        } catch (error) {
          if (error instanceof ToolError) throw error;
          if (ctx.signal.aborted || (error instanceof EgressError && error.code === 'cancelled'))
            throw new ToolError('cancelled', 'the tool call was cancelled');
          throw new ToolError('failed', error instanceof Error ? error.message : String(error));
        }
      },
    };
  }
}
