import { describe, expect, it } from 'vitest';
import { textPart, type Part, type Principal } from '@genai/contracts';
import { createKernel, type Strategy } from '@genai/kernel';
import {
  createMcpApp,
  protocolVersion,
  type CapabilityEntry,
  type ConversationTurn,
} from './index.js';
import { defaultOutput, SOURCES_MIME, structuredContent } from './tools.js';

const sources: Part = {
  mime: SOURCES_MIME,
  body: {
    kind: 'json',
    json: {
      sources: [
        { chunkId: 'c1', document: 'd1', text: 'Første' },
        { chunkId: 'c2', document: 'd1', text: 'Andre' },
      ],
    },
  },
};

const answer = (meta: Record<string, unknown>): Part => ({
  ...textPart('Første [1] og andre [2].'),
  meta,
});

describe('citation markers in structuredContent', () => {
  it('lists every marker with the one excerpt and the document it leads to, when the answer cites excerpts', () => {
    const { structured } = defaultOutput([
      answer({
        citations: [
          { index: 1, chunkId: 'c1', document: 'd1' },
          { index: 2, chunkId: 'c2', document: 'd1' },
          { index: 3, chunkId: 'not-a-source', document: 'd9' },
        ],
        citeBy: 'excerpt',
      }),
      sources,
    ]);
    const out = structuredContent(structured, 'conv');

    expect(out.markers).toEqual([
      { marker: '1', chunk_id: 'c1', document: 'd1' },
      { marker: '2', chunk_id: 'c2', document: 'd1' },
    ]);
    expect(Object.keys(out).at(-1)).toBe('chunks');
  });

  it('adds no markers when the answer cites documents', () => {
    const { structured } = defaultOutput([
      answer({
        citations: [
          { index: 1, chunkId: 'c1' },
          { index: 2, chunkId: 'c2' },
        ],
      }),
      sources,
    ]);

    expect(structuredContent(structured, 'conv')).not.toHaveProperty('markers');
  });
});

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };
const entry: CapabilityEntry = { id: 'ka__default', capability: 'answer' };

const storedTurns = async (meta: Record<string, unknown>) => {
  const strategy: Strategy = {
    id: 'answer',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* () {
      yield { type: 'kernel.result', data: [answer(meta), sources] };
    },
  };
  const kernel = createKernel({
    strategies: [strategy],
    capabilities: [
      {
        descriptor: {
          id: 'answer',
          version: '1',
          tenant,
          title: 'answer',
          description: 'answer',
          input: {},
          interaction: ['unary'],
          accepts: [],
          produces: [],
          emits: [],
          oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: 'KI' },
        },
        strategy: { id: 'answer', version: '1' },
        config: {},
        grants: [],
      },
    ],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  const turns: ConversationTurn[] = [];
  const app = createMcpApp({
    kernel,
    resolver: {
      list: async () => [entry],
      resolve: async () => ({ ok: true, entry }),
    },
    auth: { authenticate: async () => kari },
    conversations: {
      open: async () => ({ ok: true, id: 'conv', history: [] }),
      append: async (_request, _id, turn) => {
        turns.push(turn);
      },
    },
  });
  const params = { name: entry.id, arguments: { query: 'Hva?' } };
  const response = await app.request('/api/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
    headers: {
      'content-type': 'application/json',
      'MCP-Protocol-Version': protocolVersion,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': entry.id,
    },
  });
  const body = (await response.json()) as { result: { structuredContent: { markers?: unknown } } };
  return { structured: body.result.structuredContent, assistant: turns.at(-1) };
};

describe('citation markers in a stored conversation turn', () => {
  it('keeps the markers of an answer that cites excerpts when the turn is stored', async () => {
    const { structured, assistant } = await storedTurns({
      citations: [
        { index: 1, chunkId: 'c1', document: 'd1' },
        { index: 2, chunkId: 'c2', document: 'd1' },
      ],
      citeBy: 'excerpt',
    });

    expect(assistant?.role).toBe('assistant');
    expect(assistant?.markers).toEqual([
      { marker: '1', chunk_id: 'c1', document: 'd1' },
      { marker: '2', chunk_id: 'c2', document: 'd1' },
    ]);
    expect(assistant?.markers).toEqual(structured.markers);
  });

  it('stores a turn that cites documents with its chunks and no markers, as before', async () => {
    const { assistant } = await storedTurns({
      citations: [
        { index: 1, chunkId: 'c1' },
        { index: 2, chunkId: 'c2' },
      ],
    });

    expect(assistant?.role).toBe('assistant');
    expect(assistant).not.toHaveProperty('markers');
    expect(assistant?.chunks?.map((c) => c.chunkId)).toEqual(['c1', 'c2']);
  });
});
