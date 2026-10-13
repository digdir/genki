import {
  authHeaders,
  type Connection,
  type EgressGuard,
  type TenantSecrets,
} from '@genai/providers-mcp-client';

export const clientA2aVersion = '1.0';

export interface RemotePart {
  text?: string;
  data?: unknown;
  url?: string;
  raw?: string;
  mediaType?: string;
  filename?: string;
}

export interface RemoteMessage {
  messageId?: string;
  role?: string;
  parts?: RemotePart[];
  contextId?: string;
  taskId?: string;
}

export interface RemoteTask {
  id: string;
  contextId?: string;
  status?: { state?: string; message?: RemoteMessage };
  artifacts?: { artifactId?: string; name?: string; parts?: RemotePart[] }[];
}

export interface RemoteSkill {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  version?: string;
  supportedInterfaces?: { url: string; protocolBinding: string; protocolVersion: string }[];
  capabilities?: {
    streaming?: boolean;
    extensions?: { uri?: string; params?: Record<string, unknown> }[];
  };
  skills?: RemoteSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

export class A2aProtocolError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'A2aProtocolError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const cardProblems = (raw: unknown): string[] => {
  if (!isRecord(raw)) return ['the agent card is not a JSON object'];
  const problems: string[] = [];
  for (const key of ['name', 'description'])
    if (typeof raw[key] !== 'string' || raw[key] === '') problems.push(`the card has no ${key}`);
  for (const key of ['skills', 'supportedInterfaces', 'defaultInputModes', 'defaultOutputModes'])
    if (!Array.isArray(raw[key])) problems.push(`the card has no ${key}`);
  if (Array.isArray(raw.supportedInterfaces) && !jsonRpcInterface(raw as unknown as AgentCard))
    problems.push('the card has no JSONRPC interface for A2A 1.x');
  return problems;
};

export const jsonRpcInterface = (card: AgentCard) =>
  card.supportedInterfaces?.find(
    (i) =>
      isRecord(i) &&
      i.protocolBinding === 'JSONRPC' &&
      typeof i.url === 'string' &&
      /^1(\.|$)/.test(String(i.protocolVersion)),
  );

export interface SendInput {
  text: string;
  data?: Record<string, unknown>;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export class A2aClient {
  #card: AgentCard | undefined;
  #nextId = 1;

  constructor(
    private readonly connection: Connection,
    private readonly guard: EgressGuard,
    private readonly secrets: TenantSecrets,
  ) {}

  #limits() {
    return {
      ...(this.connection.timeoutMs ? { timeoutMs: this.connection.timeoutMs } : {}),
      ...(this.connection.maxResponseBytes
        ? { maxResponseBytes: this.connection.maxResponseBytes }
        : {}),
    };
  }

  async card(signal?: AbortSignal): Promise<AgentCard> {
    const response = await this.guard.request(
      this.connection.allow,
      this.connection.endpoint,
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'a2a-version': clientA2aVersion,
          ...(await authHeaders(this.connection, this.guard, this.secrets, signal)),
        },
        ...this.#limits(),
      },
      signal,
    );
    if (response.status !== 200)
      throw new A2aProtocolError(`the agent card answered HTTP ${response.status}`);
    let raw: unknown;
    try {
      raw = JSON.parse(response.body);
    } catch {
      throw new A2aProtocolError('the agent card is not JSON');
    }
    const problems = cardProblems(raw);
    if (problems.length > 0) throw new A2aProtocolError(problems.join('; '));
    this.#card = raw as AgentCard;
    return this.#card;
  }

  async #rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const card = this.#card ?? (await this.card(signal));
    const target = jsonRpcInterface(card);
    if (!target) throw new A2aProtocolError('the card has no JSONRPC interface');
    const id = this.#nextId++;
    const response = await this.guard.request(
      this.connection.allow,
      target.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'a2a-version': clientA2aVersion,
          ...(await authHeaders(this.connection, this.guard, this.secrets, signal)),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        ...this.#limits(),
      },
      signal,
    );
    let message: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = JSON.parse(response.body) as typeof message;
    } catch {
      throw new A2aProtocolError(`the agent answered HTTP ${response.status} without JSON`);
    }
    if (message.error)
      throw new A2aProtocolError(
        message.error.message ?? 'the agent returned an error',
        message.error.code,
      );
    if (response.status < 200 || response.status >= 300)
      throw new A2aProtocolError(`the agent answered HTTP ${response.status}`);
    return message.result;
  }

  async send(input: SendInput, signal?: AbortSignal): Promise<RemoteTask | RemoteMessage> {
    const message = {
      messageId: crypto.randomUUID(),
      role: 'ROLE_USER',
      parts: [
        { text: input.text, mediaType: 'text/plain' },
        ...(input.data && Object.keys(input.data).length > 0
          ? [{ data: input.data, mediaType: 'application/json' }]
          : []),
      ],
      ...(input.contextId ? { contextId: input.contextId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    const result = await this.#rpc(
      'SendMessage',
      {
        message,
        configuration: { acceptedOutputModes: ['text/plain', 'text/markdown', 'application/json'] },
      },
      signal,
    );
    if (isRecord(result) && isRecord(result.task)) return result.task as unknown as RemoteTask;
    if (isRecord(result) && isRecord(result.message)) return result.message as RemoteMessage;
    throw new A2aProtocolError('the agent sent neither a task nor a message');
  }

  async task(id: string, signal?: AbortSignal): Promise<RemoteTask> {
    const result = await this.#rpc('GetTask', { id }, signal);
    if (!isRecord(result) || typeof result.id !== 'string')
      throw new A2aProtocolError('the agent sent no task');
    return result as unknown as RemoteTask;
  }
}
