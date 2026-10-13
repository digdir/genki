import {
  all,
  answered,
  callerFilterReported,
  citationsResolveByDocument,
  createdConversationId,
  followUpUsesFirst,
  noChunks,
  noPageMarkers,
  staysInConversation,
  streamsBeforeResult,
  threadHasTurns,
} from '../checks.js';
import { agentId, toolName } from '../scope.js';
import type { Captured, JsonValue, Request, Scenario, Side, StepResult } from '../types.js';

export const PROTOCOL = '2026-07-28';
const QUESTION = 'Hva sier evalueringene om digitalisering i staten?';
const PROBE_QUERY = 'tiltak og resultater';
const FOLLOW_UP = 'Hvilke av dem er fra 2023?';
const USER = { 'X-User-Id': 'parity-multi-turn' };
const IMPOSSIBLE = { fields: [{ field: 'type', 'selected-options': ['ZZZ_ingen_slik_type'] }] };

interface McpOptions {
  id?: number;
  name?: string;
  version?: string;
  headers?: Record<string, string>;
  auth?: boolean;
  notification?: boolean;
}

export const mcp = (
  method: string,
  params: Record<string, JsonValue> = {},
  options: McpOptions = {},
): Request => {
  const version = options.version ?? PROTOCOL;
  const headers: Record<string, string> = {
    'MCP-Protocol-Version': version,
    'Mcp-Method': method,
    ...(options.name ? { 'Mcp-Name': options.name } : {}),
    ...options.headers,
  };
  const meta = { 'io.modelcontextprotocol/protocolVersion': version, ...(params._meta as object) };
  return {
    method: 'POST',
    path: '/api/mcp',
    headers,
    ...(options.auth === undefined ? {} : { auth: options.auth }),
    body: {
      jsonrpc: '2.0',
      ...(options.notification ? {} : { id: options.id ?? 1 }),
      method,
      params: { ...params, _meta: meta },
    },
  };
};

const call = (
  name: string,
  args: Record<string, JsonValue>,
  meta: Record<string, JsonValue> = {},
  headers: Record<string, string> = {},
) => mcp('tools/call', { name, arguments: args, _meta: meta }, { name, headers });

const created = (previous: StepResult[]): string => {
  const id = createdConversationId(previous[0]);
  if (!id) throw new Error('the conversation create step returned no id');
  return id;
};

const conversationId = (previous: StepResult[]): string => {
  const body = previous.at(-1)?.response.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const result = body.result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const meta = result._meta;
      if (
        meta &&
        typeof meta === 'object' &&
        !Array.isArray(meta) &&
        typeof meta.conversation_id === 'string'
      ) {
        return meta.conversation_id;
      }
    }
  }
  throw new Error('previous step returned no conversation_id');
};

const agent = (side: Side) => toolName('agent', side);
const probe = (side: Side) => toolName('probe', side);

const one = (
  id: string,
  title: string,
  request: Request | ((side: Side) => Request),
  mode: 'exact' | 'shape' = 'exact',
  check?: (response: Captured) => string[],
): Scenario => ({
  id,
  title,
  steps: [
    {
      name: id,
      request: (_, side) => (typeof request === 'function' ? request(side) : request),
      mode,
      ...(check ? { check } : {}),
    },
  ],
});

export const mcpScenarios: Scenario[] = [
  one(
    'mcp.discover',
    'server/discover returns versions, capabilities and cache hints',
    mcp('server/discover'),
  ),
  one(
    'mcp.tools-list',
    'tools/list returns the tools this key can reach, with private cache hints',
    mcp('tools/list'),
  ),
  one('mcp.ping', 'ping answers with an empty result', mcp('ping')),
  one('mcp.initialize-rejected', 'initialize is refused with -32022 and the supported versions', {
    method: 'POST',
    path: '/api/mcp',
    body: { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
  }),
  one('mcp.unknown-method', 'an unknown method is HTTP 404 with -32601', mcp('nope/nothing')),
  one('mcp.get-not-allowed', 'GET is 405', { method: 'GET', path: '/api/mcp' }),
  one('mcp.delete-not-allowed', 'DELETE is 405', { method: 'DELETE', path: '/api/mcp' }),
  one('mcp.missing-headers', 'a request without metadata headers is 400 with -32020', {
    method: 'POST',
    path: '/api/mcp',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  }),
  one(
    'mcp.header-mismatch',
    'a header that contradicts the body is 400 with -32020',
    mcp('tools/list', {}, { headers: { 'Mcp-Method': 'server/discover' } }),
  ),
  one(
    'mcp.unsupported-version',
    'an older protocol version is 400 with -32022',
    mcp('tools/list', {}, { version: '2025-03-26' }),
  ),
  one(
    'mcp.notification',
    'a notification is 202 with no body',
    mcp('notifications/cancelled', { requestId: 99 }, { notification: true }),
  ),
  one(
    'mcp.no-key',
    'a request without an API key is refused',
    mcp('tools/list', {}, { auth: false }),
  ),
  one(
    'mcp.unknown-tool',
    'calling an unknown tool is an error before anything runs',
    call('no.such-agent__nothing', { query: QUESTION }),
  ),
  one(
    'mcp.invalid-overrides',
    'an override outside the allowlist fails with -32602 invalid_overrides',
    (side) => call(probe(side), { query: QUESTION, overrides: { 'retrieve-bogus': true } }),
  ),
  {
    ...one(
      'mcp.call-probe',
      "KA's capability probe tool answers",
      (side) => call(probe(side), { query: QUESTION }),
      'shape',
      all(answered, noPageMarkers),
    ),
    needs: ['dataset', 'llm'],
  },
  {
    ...one(
      'mcp.call-probe-filter-baseline',
      "KA's filter probe without a filter finds chunks",
      (side) => call(probe(side), { query: PROBE_QUERY }),
      'shape',
      answered,
    ),
    needs: ['dataset', 'llm'],
  },
  {
    ...one(
      'mcp.call-probe-impossible-filter',
      "KA's filter probe: a retrieve-filter-by that matches nothing returns no chunks",
      (side) =>
        call(probe(side), { query: PROBE_QUERY, overrides: { 'retrieve-filter-by': IMPOSSIBLE } }),
      'shape',
      noChunks,
    ),
    needs: ['dataset', 'llm'],
  },
  {
    ...one(
      'mcp.call-agent',
      "KA's agent tool answers with sources, blocking",
      (side) => call(agent(side), { query: QUESTION }),
      'shape',
      all(answered, noPageMarkers, citationsResolveByDocument),
    ),
    needs: ['dataset', 'llm'],
  },
  {
    ...one(
      'mcp.call-agent-stream',
      "KA's agent tool streams progress and a final result",
      (side) => call(agent(side), { query: QUESTION }, { progressToken: 'parity' }),
      'shape',
      all(answered, streamsBeforeResult, citationsResolveByDocument),
    ),
    needs: ['dataset', 'llm'],
    comparedHeaders: ['content-type', 'cache-control', 'x-accel-buffering'],
  },
  {
    ...one(
      'mcp.call-with-filter',
      'a caller filter is applied and reported in filters_applied',
      (side) =>
        call(agent(side), {
          query: QUESTION,
          overrides: {
            'retrieve-filter-by': {
              fields: [{ field: 'type', 'selected-options': ['Evaluering'] }],
            },
          },
        }),
      'shape',
      all(answered, callerFilterReported),
    ),
    needs: ['dataset', 'llm'],
  },
  {
    id: 'mcp.conversation-continue',
    title:
      'a second call with conversation_id continues the conversation, and GET returns both turns in order',
    needs: ['dataset', 'llm'],
    steps: [
      {
        name: 'first',
        mode: 'shape',
        request: (_, side) => call(agent(side), { query: QUESTION }, {}, USER),
      },
      {
        name: 'follow-up',
        mode: 'shape',
        request: (previous, side) =>
          call(
            agent(side),
            { query: FOLLOW_UP, conversation_id: conversationId(previous) },
            {},
            USER,
          ),
        check: all(answered, followUpUsesFirst),
      },
      {
        name: 'read',
        mode: 'shape',
        request: (previous) => ({
          method: 'GET',
          path: `/api/conversations/${encodeURIComponent(conversationId(previous.slice(0, 1)))}`,
          headers: USER,
        }),
        check: threadHasTurns([QUESTION, FOLLOW_UP]),
      },
    ],
  },
  {
    id: 'mcp.conversation-multi-turn',
    title:
      'a REST conversation carries two MCP turns: the second uses the first and GET returns all four messages',
    needs: ['dataset', 'llm'],
    steps: [
      {
        name: 'create',
        mode: 'shape',
        request: (_, side) => ({
          method: 'POST',
          path: '/api/conversations',
          headers: USER,
          body: { agentId: agentId('agent', side), title: 'Paritet, flere runder' },
        }),
      },
      {
        name: 'first',
        mode: 'shape',
        request: (previous, side) =>
          call(agent(side), { query: QUESTION, conversation_id: created(previous) }, {}, USER),
        check: all(answered, staysInConversation),
      },
      {
        name: 'follow-up',
        mode: 'shape',
        request: (previous, side) =>
          call(agent(side), { query: FOLLOW_UP, conversation_id: created(previous) }, {}, USER),
        check: all(answered, staysInConversation, followUpUsesFirst),
      },
      {
        name: 'read',
        mode: 'shape',
        request: (previous) => ({
          method: 'GET',
          path: `/api/conversations/${encodeURIComponent(created(previous))}`,
          headers: USER,
        }),
        check: threadHasTurns([QUESTION, FOLLOW_UP]),
      },
    ],
  },
];
