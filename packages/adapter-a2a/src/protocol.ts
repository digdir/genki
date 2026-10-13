import type { InputField, JSONSchema, Part, Task, TaskStatus } from '@genai/contracts';

export const a2aVersion = '1.0';

export type TaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

export interface A2aPart {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}

export interface A2aMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPart[];
  metadata?: Record<string, unknown>;
}

export interface A2aTaskStatus {
  state: TaskState;
  message?: A2aMessage;
  timestamp?: string;
}

export interface A2aTask {
  id: string;
  contextId?: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
}

export const errorCodes = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotSupported: -32003,
  unsupported: -32004,
  contentType: -32005,
  extendedCardNotConfigured: -32007,
  versionNotSupported: -32009,
} as const;

export type JsonRpcId = string | number | null;

export const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });

export const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});

export const stateOf: Record<TaskStatus, TaskState> = {
  queued: 'TASK_STATE_SUBMITTED',
  running: 'TASK_STATE_WORKING',
  interrupted: 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  cancelled: 'TASK_STATE_CANCELED',
};

export const terminal = (status: TaskStatus) =>
  status === 'completed' || status === 'failed' || status === 'cancelled';

export const SOURCES_MIME = 'application/vnd.genai.sources+json';
const RETRIEVAL_MIME = 'application/vnd.genai.retrieval+json';
export const NO_ANSWER_NOTICE = 'Fant ikke noe svar.';

export const toA2aParts = (parts: Part[]): A2aPart[] =>
  parts.flatMap((p): A2aPart[] => {
    if (p.mime === RETRIEVAL_MIME) return [];
    const body = p.body;
    if (body.kind === 'text') return [{ text: body.text, mediaType: p.mime }];
    if (body.kind === 'json') return [{ data: body.json, mediaType: p.mime }];
    if (body.kind === 'uri') return [{ url: body.uri, mediaType: p.mime }];
    return [];
  });

export const answerArtifact = (task: string, parts: Part[]): A2aArtifact => {
  const mapped = toA2aParts(parts);
  const answered = mapped.some((p) => typeof p.text === 'string' && p.text.trim() !== '');
  const hasFields = mapped.some((p) => p.data !== undefined && p.mediaType !== SOURCES_MIME);
  return {
    artifactId: `${task}-answer`,
    name: 'answer',
    parts:
      answered || hasFields
        ? mapped
        : [{ text: NO_ANSWER_NOTICE, mediaType: 'text/plain' }, ...mapped],
    ...(answered || hasFields ? {} : { metadata: { noAnswer: true } }),
  };
};

export const agentMessage = (text: string, task: string, contextId?: string): A2aMessage => ({
  messageId: `${task}-${Date.now().toString(36)}`,
  role: 'ROLE_AGENT',
  taskId: task,
  ...(contextId ? { contextId } : {}),
  parts: [{ text, mediaType: 'text/plain' }],
});

export const toA2aTask = (task: Task, extra: { metadata?: Record<string, unknown> } = {}) => {
  const contextId = task.thread;
  const interrupt = task.pendingInterrupt;
  const status: A2aTaskStatus = {
    state: stateOf[task.status],
    timestamp: task.endedAt ?? task.createdAt,
    ...(task.status === 'interrupted' && interrupt
      ? {
          message: {
            messageId: `${task.id}-${interrupt.id}`,
            role: 'ROLE_AGENT',
            taskId: task.id,
            ...(contextId ? { contextId } : {}),
            parts: toA2aParts(interrupt.prompt),
            metadata: {
              interruptId: interrupt.id,
              reason: interrupt.reason,
              ...(interrupt.responseSchema ? { responseSchema: interrupt.responseSchema } : {}),
            },
          },
        }
      : {}),
  };
  const out: A2aTask = {
    id: task.id,
    ...(contextId ? { contextId } : {}),
    status,
    ...(task.status === 'completed' && task.result
      ? { artifacts: [answerArtifact(task.id, task.result)] }
      : {}),
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
  };
  return out;
};

export interface AgentEntry {
  id: string;
  capability: string;
  title?: string;
  serviceTitle?: string;
  variantTitle?: string;
  mode?: string;
  description?: string;
  inputSchema?: JSONSchema;
  inputFields?: InputField[];
  version?: number;
  status?: string;
}

export const inputSchemaExtension = 'urn:genai:a2a:input-schema:v1';

const outputModes = ['text/plain', 'text/markdown', 'application/json'];

export interface CardOptions {
  url: string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
}

export const cardName = (entry: AgentEntry) =>
  !entry.serviceTitle
    ? (entry.title ?? entry.id)
    : entry.mode === 'default' || !entry.variantTitle
      ? entry.serviceTitle
      : `${entry.serviceTitle} · ${entry.variantTitle}`;

export const agentCard = (entry: AgentEntry, options: CardOptions) => {
  const name = cardName(entry);
  const description = entry.description?.trim() || name;
  const fields = entry.inputFields?.length ? entry.inputFields : undefined;
  return {
    name,
    description,
    supportedInterfaces: [
      { url: options.url, protocolBinding: 'JSONRPC', protocolVersion: a2aVersion },
    ],
    ...(options.provider ? { provider: options.provider } : {}),
    version: String(entry.version ?? 1),
    ...(options.documentationUrl ? { documentationUrl: options.documentationUrl } : {}),
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: inputSchemaExtension,
          description:
            'JSON Schema for a data part the agent reads beside the text; send field values as a data part.',
          required: false,
          params: {
            schema: entry.inputSchema ?? { type: 'object' },
            ...(fields ? { fields } : {}),
          },
        },
      ],
    },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
      apiKey: { apiKeySecurityScheme: { location: 'header', name: 'x-api-key' } },
    },
    securityRequirements: [
      { schemes: { bearer: { list: [] } } },
      { schemes: { apiKey: { list: [] } } },
    ],
    defaultInputModes: fields ? ['text/plain', 'application/json'] : ['text/plain'],
    defaultOutputModes: outputModes,
    skills: [
      {
        id: entry.id,
        name,
        description,
        tags: ['genai', ...(fields ? ['form'] : [])],
        inputModes: fields ? ['text/plain', 'application/json'] : ['text/plain'],
        outputModes,
      },
    ],
  };
};

export const publicAgentCard = (
  entry: AgentEntry,
  options: { url: string; provider: { organization: string; url: string } },
) => {
  const full = agentCard(entry, { url: options.url });
  return {
    name: full.name,
    description: full.description,
    version: full.version,
    provider: options.provider,
    supportedInterfaces: full.supportedInterfaces,
    capabilities: { streaming: true },
    securitySchemes: full.securitySchemes,
    securityRequirements: full.securityRequirements,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: full.defaultOutputModes,
    skills: [{ id: entry.id, name: full.name, description: full.description, tags: ['genai'] }],
  };
};

export const acceptsOutput = (accepted: unknown) =>
  !Array.isArray(accepted) ||
  accepted.length === 0 ||
  accepted.some((m) => typeof m === 'string' && (outputModes.includes(m) || m === '*/*'));
