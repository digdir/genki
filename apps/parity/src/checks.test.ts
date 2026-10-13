import { describe, expect, it } from 'vitest';
import {
  callerFilterReported,
  citationsResolveByDocument,
  noPageMarkers,
  streamsBeforeResult,
} from './checks.js';
import type { Captured, JsonValue } from './types.js';

const reply = (result: JsonValue): Captured => ({ status: 200, headers: {}, body: { result } });

const agentResult = (text: string, chunks: JsonValue[]) =>
  reply({ isError: false, content: [{ type: 'text', text }], structuredContent: { chunks } });

describe('checks of what KA needs from the new platform', () => {
  it('resolves each [N] to the Nth document, counting chunks of one document once', () => {
    const chunks = [
      { chunk_id: 'a', doc_num: 'd1' },
      { chunk_id: 'b', doc_num: 'd1' },
      { chunk_id: 'c', doc_num: 'd2' },
    ];
    expect(citationsResolveByDocument(agentResult('Svar [1] og [2].', chunks))).toEqual([]);
    expect(citationsResolveByDocument(agentResult('Svar [3].', chunks))).toEqual([
      '[3] has no source among 2 documents',
    ]);
  });

  it('finds page markers in chunk text', () => {
    expect(
      noPageMarkers(agentResult('x', [{ chunk_id: 'a', content_markdown: '{0}\n\nTekst' }])),
    ).toEqual(['chunk a carries a page marker']);
  });

  it('requires the caller filter in filters_applied', () => {
    const applied = (source: string) =>
      reply({
        structuredContent: {
          filters_applied: [{ filter: { fields: [{ field: 'type' }] }, source }],
        },
      });
    expect(callerFilterReported(applied('explicit'))).toEqual([]);
    expect(callerFilterReported(applied('auto'))).toHaveLength(1);
  });

  it('requires agent steps and answer text as progress frames in a stream', () => {
    const progress = (event: string): JsonValue => ({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { _meta: { event } },
    });
    const stream = (events: string[]): Captured => ({
      status: 200,
      headers: {},
      frames: [
        ...events.map((e) => ({ kind: 'data' as const, data: progress(e) })),
        { kind: 'data', data: { result: {} } },
      ],
    });
    expect(
      streamsBeforeResult(
        stream(['agent/iteration-started', 'agent/turn-completed', 'response/chunk']),
      ),
    ).toEqual([]);
    expect(streamsBeforeResult(stream(['request/started']))).toHaveLength(3);
  });
});
