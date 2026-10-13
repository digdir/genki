import { describe, expect, it } from 'vitest';
import { followUpUsesFirst, staysInConversation, threadHasTurns } from './checks.js';
import { mergeReports, type ScenarioReport } from './runner.js';
import { allScenarios } from './scenarios/index.js';
import type { Captured, JsonValue, StepResult } from './types.js';

const created: StepResult = {
  request: { method: 'POST', path: '/api/conversations' },
  response: { status: 201, headers: {}, body: { conversation: { id: 'conv-1' } } },
};

const answer = (
  meta: Record<string, JsonValue>,
  chunks: JsonValue[],
  text = 'Svar [1].',
): Captured => ({
  status: 200,
  headers: {},
  body: {
    result: {
      isError: false,
      content: [{ type: 'text', text }],
      structuredContent: { chunks },
      _meta: meta,
    },
  },
});

const step = (response: Captured): StepResult => ({
  request: { method: 'POST', path: '/api/mcp' },
  response,
});

const first = answer({ conversation_id: 'conv-1' }, [
  { chunk_id: 'a', doc_num: 'd1', title: 'Evaluering av digitalisering i staten' },
]);

describe('the multi-turn parity scenario', () => {
  it('is defined over REST create, two MCP turns and a GET, and needs a model', () => {
    const scenario = allScenarios.find((s) => s.id === 'mcp.conversation-multi-turn');

    expect(scenario?.steps.map((s) => s.name)).toEqual(['create', 'first', 'follow-up', 'read']);
    expect(scenario?.needs).toContain('llm');
  });

  it('the continue scenario reads the thread back after its two MCP turns', () => {
    const scenario = allScenarios.find((s) => s.id === 'mcp.conversation-continue');

    expect(scenario?.steps.map((s) => s.name)).toEqual(['first', 'follow-up', 'read']);
    expect(scenario?.steps[2]?.check).toBeDefined();
  });

  it('an MCP turn must stay in the conversation created over REST', () => {
    expect(staysInConversation(first, [created])).toEqual([]);
    expect(
      staysInConversation(answer({ conversation_id: 'minted-elsewhere' }, []), [created]),
    ).toEqual([
      'the answer belongs to conversation minted-elsewhere, not the one created (conv-1)',
    ]);
  });

  it('the follow-up must build on the first turn, by a shared document or a named source', () => {
    const shared = answer({ conversation_id: 'conv-1' }, [{ chunk_id: 'b', doc_num: 'd1' }]);
    const named = answer(
      { conversation_id: 'conv-1' },
      [{ chunk_id: 'z', doc_num: 'd9' }],
      'Evaluering av digitalisering i staten er fra 2023 [1].',
    );
    const lost = answer(
      { conversation_id: 'conv-1' },
      [{ chunk_id: 'z', doc_num: 'd9' }],
      'Hva mener du?',
    );

    expect(followUpUsesFirst(shared, [created, step(first)])).toEqual([]);
    expect(followUpUsesFirst(named, [created, step(first)])).toEqual([]);
    expect(followUpUsesFirst(lost, [created, step(first)])).toEqual([
      'the follow-up neither cites a document from the first turn nor names one of its sources',
    ]);
  });

  it('a follow-up that asks for clarification shows the first turn never reached the model', () => {
    const clarify = answer({ conversation_id: 'conv-1', status: 'needs-clarification' }, []);

    expect(followUpUsesFirst(clarify, [created, step(first)])).toEqual([
      'the follow-up asks for clarification, so the first turn did not reach it',
    ]);
  });

  it('reading the thread must return both questions and both answers in order', () => {
    const thread = (messages: JsonValue[]): Captured => ({
      status: 200,
      headers: {},
      body: { conversation: { id: 'conv-1' }, messages },
    });
    const check = threadHasTurns(['Spørsmål 1', 'Spørsmål 2']);

    expect(
      check(
        thread([
          { role: 'system', text: 'seed' },
          { role: 'user', text: 'Spørsmål 1' },
          { role: 'assistant', text: 'Svar 1' },
          { role: 'user', text: 'Spørsmål 2' },
          { role: 'assistant', text: 'Svar 2' },
        ]),
        [],
      ),
    ).toEqual([]);
    expect(check(thread([{ role: 'system', text: 'seed' }]), [])).toEqual([
      'the thread has roles [], expected [user, assistant, user, assistant]',
    ]);
  });
});

describe('the recorded parity report', () => {
  const ran: ScenarioReport = {
    scenario: 'mcp.discover',
    title: 'x',
    outcome: 'pass',
    differences: [],
  };

  it('lists every scenario, marking LLM scenarios that were not run instead of leaving them out', () => {
    const merged = mergeReports([], [ran], allScenarios, 'not run yet: excluded by --skip llm');

    expect(merged).toHaveLength(allScenarios.length);
    expect(merged.find((r) => r.scenario === 'mcp.conversation-multi-turn')).toMatchObject({
      outcome: 'not-run',
      needs: ['dataset', 'llm'],
      error: 'not run yet: excluded by --skip llm',
    });
  });

  it('keeps an earlier LLM run when a later run covers only the protocol scenarios', () => {
    const earlier: ScenarioReport = {
      scenario: 'mcp.call-agent',
      title: 'x',
      outcome: 'pass',
      differences: [],
      ranAt: '2026-10-09T10:00:00.000Z',
    };
    const merged = mergeReports([earlier], [ran], allScenarios, 'excluded');

    expect(merged.find((r) => r.scenario === 'mcp.call-agent')).toEqual(earlier);
    expect(merged.find((r) => r.scenario === 'mcp.discover')).toEqual(ran);
  });
});
