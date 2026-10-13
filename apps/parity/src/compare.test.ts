import { describe, expect, it } from 'vitest';
import { canonicalRanking, compareCaptured, compareRanked, normalize, shape } from './compare.js';
import { parseSse } from './http.js';

describe('normalize', () => {
  it('replaces ids, timestamps and volatile fields so two runs can be compared', () => {
    expect(
      normalize({
        id: '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90',
        at: '2026-10-06T08:00:00.123Z',
        _meta: { conversation_id: 'convo-abc', status: 'complete' },
      }),
    ).toEqual({
      id: '<uuid>',
      at: '<timestamp>',
      _meta: { conversation_id: '<volatile>', status: 'complete' },
    });
  });
});

describe('shape', () => {
  it('keeps keys and types, and drops values', () => {
    expect(shape({ b: [1, 2], a: { text: 'svar' } })).toEqual({
      a: { text: 'string' },
      b: ['number'],
    });
  });
});

describe('compareCaptured', () => {
  const ok = { status: 200, headers: { 'content-type': 'application/json' } };

  it('finds no differences between two runs that differ only in volatile values', () => {
    const a = { ...ok, body: { result: { _meta: { conversation_id: 'a' } } } };
    const b = { ...ok, body: { result: { _meta: { conversation_id: 'b' } } } };
    expect(compareCaptured(a, b, 'exact')).toEqual([]);
  });

  it('reports a different status, header and error code', () => {
    const a = { ...ok, status: 404, body: { error: { code: -32601 } } };
    const b = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: { error: { code: -32600 } },
    };
    expect(compareCaptured(a, b, 'exact').map((d) => d.path)).toEqual([
      '$.status',
      '$.headers.content-type',
      '$.body.error.code',
    ]);
  });

  it('accepts a different answer text in shape mode, but not a missing field', () => {
    const a = {
      ...ok,
      body: { result: { content: [{ type: 'text', text: 'ett svar' }], isError: false } },
    };
    const reworded = {
      ...ok,
      body: { result: { content: [{ type: 'text', text: 'et annet svar' }], isError: false } },
    };
    const missing = { ...ok, body: { result: { content: [{ type: 'text', text: 'svar' }] } } };
    expect(compareCaptured(a, reworded, 'shape')).toEqual([]);
    expect(compareCaptured(a, missing, 'shape').map((d) => d.path)).toEqual([
      '$.body.result.isError',
    ]);
  });

  it('compares the final frame of a stream and warns when progress events differ', () => {
    const stream = (events: string[]) => ({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      frames: [
        ...events.map((event) => ({
          kind: 'data' as const,
          data: { params: { _meta: { event } } },
        })),
        { kind: 'data' as const, data: { id: 1, result: { isError: false } } },
      ],
    });
    const differences = compareCaptured(
      stream(['tool/call', 'response/chunk']),
      stream(['response/chunk']),
      'shape',
    );
    expect(differences).toEqual([
      expect.objectContaining({ severity: 'warn', path: '$.progressEvents' }),
    ]);
  });
});

describe('parseSse', () => {
  it('splits data frames and heartbeat comments', () => {
    const frames = parseSse(': ping\n\ndata: {"a":1}\n\ndata: [DONE]\n\n');
    expect(frames).toEqual([
      { kind: 'comment', text: 'ping' },
      { kind: 'data', data: { a: 1 } },
      { kind: 'data', data: '[DONE]' },
    ]);
  });
});

describe('nondeterminism rules', () => {
  it('treats generated completion and tool call ids as equal', () => {
    expect(normalize({ id: 'chatcmpl-abc123', call: 'call_Xy9', msg: 'msg_01AbC' })).toEqual({
      id: '<completion-id>',
      call: '<tool-call-id>',
      msg: '<generated-id>',
    });
  });

  it('accepts a different order inside a group of equal scores, and nothing else', () => {
    const old = [
      { id: 'c1', score: 0.9 },
      { id: 'c2', score: 0.5 },
      { id: 'c3', score: 0.5 },
      { id: 'c4', score: 0.1 },
    ];
    const swappedTie = [old[0], old[2], old[1], old[3]] as typeof old;
    const swappedRank = [old[1], old[0], old[2], old[3]] as typeof old;

    expect(compareRanked(old, swappedTie)).toEqual([]);
    expect(compareRanked(old, swappedRank)).toHaveLength(1);
    expect(canonicalRanking(swappedTie)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('compares unscored rankings strictly by position', () => {
    expect(compareRanked([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }])).toHaveLength(1);
  });
});

describe('parity scope', () => {
  const scope = new Set([
    'builtin.agent-rag-agent__agent-rag-graph-bundled',
    'builtin.retrieve-only-agent__retrieve-only',
  ]);
  const listing = (names: string[], title = 'x') => ({
    status: 200,
    headers: {},
    body: { result: { tools: names.map((name) => ({ name, title })) } },
  });

  it('compares only the capabilities in scope, in name order, and ignores the rest', () => {
    const old = listing([
      'builtin.fact-checker-agent__fact-checker',
      'builtin.retrieve-only-agent__retrieve-only',
      'builtin.agent-rag-agent__agent-rag-graph-bundled',
    ]);
    const next = listing([
      'builtin.agent-rag-agent__agent-rag-graph-bundled',
      'kunnskapsassistenten__default',
      'builtin.retrieve-only-agent__retrieve-only',
    ]);

    expect(compareCaptured(old, next, 'exact', [], scope)).toEqual([]);
  });

  it('still fails when a capability in scope is missing or differs', () => {
    const old = listing([
      'builtin.agent-rag-agent__agent-rag-graph-bundled',
      'builtin.retrieve-only-agent__retrieve-only',
    ]);

    expect(
      compareCaptured(
        old,
        listing(['builtin.agent-rag-agent__agent-rag-graph-bundled']),
        'exact',
        [],
        scope,
      ),
    ).not.toEqual([]);
    expect(
      compareCaptured(
        old,
        listing(
          [
            'builtin.agent-rag-agent__agent-rag-graph-bundled',
            'builtin.retrieve-only-agent__retrieve-only',
          ],
          'y',
        ),
        'exact',
        [],
        scope,
      ),
    ).not.toEqual([]);
  });
});

describe('generated ids', () => {
  it('treats 21-character random ids as generated, but not words, numbers or chunk ids', () => {
    expect(normalize('qK6y6u9PuecXUCdRvuNoe')).toBe('<generated-id>');
    expect(normalize('ab897fbdedfa')).toBe('ab897fbdedfa');
    expect(normalize('kunnskapsassistentenx')).toBe('kunnskapsassistentenx');
    expect(normalize('123456789012345678901')).toBe('123456789012345678901');
  });
});
