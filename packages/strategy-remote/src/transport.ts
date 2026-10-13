import type { Part } from '@genai/contracts';
import type { SecretResolver } from '@genai/kernel';
import {
  authHeaders,
  EgressError,
  TenantSecrets,
  type Connection,
  type EgressGuard,
} from '@genai/providers-mcp-client';
import { A2aClient, toToolResult, type RemoteTask } from '@genai/providers-a2a-client';
import {
  remoteAgentContract,
  remoteReply,
  type RemoteReply,
  type RemoteRequest,
} from './contract.js';
import type { RemoteEndpoint } from './config.js';

export interface RemoteCall {
  endpoint: RemoteEndpoint;
  owner: string;
  request: RemoteRequest;
  signal: AbortSignal;
}

export interface RemoteTransport {
  call(call: RemoteCall): Promise<RemoteReply>;
}

export class RemoteAgentError extends Error {
  constructor(
    readonly code: 'unreachable' | 'refused' | 'bad_reply' | 'cancelled' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'RemoteAgentError';
  }
}

export interface TransportOptions {
  guard: EgressGuard;
  secrets: SecretResolver;
  pollMs?: number;
}

const allowFor = (url: string) => {
  const u = new URL(url);
  return [{ host: u.hostname, port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80 }];
};

const connectionFor = (call: RemoteCall): Connection => {
  const { endpoint, owner } = call;
  return {
    id: 'remote-agent',
    tenant: owner,
    name: 'remote-agent',
    protocol: 'a2a',
    endpoint: endpoint.url,
    version: '1',
    allow: allowFor(endpoint.url),
    timeoutMs: Math.min(endpoint.timeoutMs, 60_000),
    maxResponseBytes: endpoint.maxResponseBytes,
    ...(endpoint.auth
      ? {
          auth:
            endpoint.auth.kind === 'bearer'
              ? { kind: 'bearer', secret: endpoint.auth.secret }
              : {
                  kind: 'header',
                  header: endpoint.auth.header ?? 'x-api-key',
                  secret: endpoint.auth.secret,
                },
        }
      : {}),
  } as Connection;
};

const failure = (error: unknown, host: string): RemoteAgentError => {
  if (error instanceof RemoteAgentError) return error;
  if (error instanceof EgressError)
    return new RemoteAgentError(
      error.code === 'cancelled'
        ? 'cancelled'
        : error.code === 'not_allowed' ||
            error.code === 'private_address' ||
            error.code === 'insecure'
          ? 'refused'
          : 'unreachable',
      `the remote agent at ${host} could not be reached: ${error.message}`,
    );
  return new RemoteAgentError(
    'failed',
    `the remote agent at ${host} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
};

const finished = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

const isTask = (v: unknown): v is RemoteTask =>
  typeof (v as RemoteTask).id === 'string' && typeof (v as RemoteTask).status === 'object';

const textOf = (parts: Part[]) =>
  parts.flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : [])).join('\n\n');

export const createRemoteTransport = (options: TransportOptions): RemoteTransport => {
  const secrets = new TenantSecrets(options.secrets);

  const http = async (call: RemoteCall): Promise<RemoteReply> => {
    const { endpoint, owner } = call;
    const host = new URL(endpoint.url).hostname;
    const auth = endpoint.auth
      ? await authHeaders(connectionFor(call), options.guard, secrets, call.signal)
      : {};
    const response = await options.guard.request(
      allowFor(endpoint.url),
      endpoint.url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-genai-contract': remoteAgentContract,
          'x-genai-tenant': owner,
          ...auth,
        },
        body: JSON.stringify(call.request),
        timeoutMs: endpoint.timeoutMs,
        maxResponseBytes: endpoint.maxResponseBytes,
      },
      call.signal,
    );
    if (response.status < 200 || response.status >= 300)
      throw new RemoteAgentError(
        'failed',
        `the remote agent at ${host} answered HTTP ${response.status}`,
      );
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new RemoteAgentError(
        'bad_reply',
        `the remote agent at ${host} did not answer with JSON`,
      );
    }
    const parsed = remoteReply.safeParse(body);
    if (!parsed.success)
      throw new RemoteAgentError(
        'bad_reply',
        `the remote agent at ${host} broke the ${remoteAgentContract} reply: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    return parsed.data;
  };

  const a2a = async (call: RemoteCall): Promise<RemoteReply> => {
    const client = new A2aClient(connectionFor(call), options.guard, secrets);
    const { request } = call;
    let answer = await client.send(
      {
        text: request.query,
        data: { messages: request.messages, context: request.context, metadata: request.metadata },
        contextId: request.conversation.id,
      },
      call.signal,
    );
    const started = Date.now();
    while (
      isTask(answer) &&
      !finished.has(answer.status?.state ?? '') &&
      Date.now() - started < call.endpoint.timeoutMs
    ) {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
      if (call.signal.aborted) throw new RemoteAgentError('cancelled', 'the call was cancelled');
      answer = await client.task(answer.id, call.signal);
    }
    if (isTask(answer) && !finished.has(answer.status?.state ?? ''))
      throw new RemoteAgentError('failed', 'the remote agent did not finish in time');
    const result = toToolResult('remote-agent', answer);
    if (result.isError)
      throw new RemoteAgentError(
        'failed',
        `the remote agent failed: ${textOf(result.parts)}`.slice(0, 400),
      );
    return {
      answer: textOf(result.parts),
      ...(result.sources?.length ? { sources: result.sources.map((s) => ({ ...s })) } : {}),
    };
  };

  return {
    call: async (call) => {
      const host = new URL(call.endpoint.url).hostname;
      try {
        return call.endpoint.protocol === 'a2a' ? await a2a(call) : await http(call);
      } catch (error) {
        throw failure(error, host);
      }
    },
  };
};
