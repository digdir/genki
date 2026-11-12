import { describe, expect, it } from 'vitest';
import {
  array,
  chatShape,
  decideShape,
  embedShape,
  issued,
  json,
  longestBase64Run,
  maxDecisionQuestions,
  object,
  oneOf,
  opaque,
  optional,
  plain,
  ref,
  rerankShape,
  text,
  variant,
  walk,
} from './payload.js';

const request = { side: 'request' } as const;
const result = { side: 'result' } as const;
const replay = array(variant('type', { note: { text: plain() } }));

const fullChat = {
  messages: [
    { role: 'system', content: 'Svar kort.' },
    { role: 'user', content: 'Finn Oslo' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'search', arguments: '{"q":"Oslo"}' }],
      continuation: [{ type: 'note', text: 'tenker' }],
    },
    { role: 'tool', content: 'Oslo er hovedstaden', toolCallId: 'call_1' },
  ],
  tools: [
    {
      name: 'search',
      description: 'See https://docs.example/search',
      parameters: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' },
    },
  ],
  temperature: 0.2,
  maxTokens: 400,
  reasoning: 'low',
  jsonSchema: { name: 'answer', schema: { type: 'object' } },
  purpose: 'answer',
};

describe('closed payload shapes', () => {
  it('the walker masks every string inside json, keys included', () => {
    const walked = walk(
      object({ context: json }),
      { context: { 'kari@example.no': ['ring kari@example.no', 3, { note: 'kari@example.no' }] } },
      { side: 'request', map: (t) => t.replaceAll('kari@example.no', '[EMAIL]') },
    );
    expect(walked.value).toEqual({
      context: { '[EMAIL]': ['ring [EMAIL]', 3, { note: '[EMAIL]' }] },
    });
  });

  it('lets every field the model port has through the chat shape', () => {
    const walked = walk(chatShape([replay]).request, fullChat, request);
    expect(walked.problems).toEqual([]);
    expect(walked.value).toEqual(fullChat);
  });

  it('refuses an unknown request field and names where it is', () => {
    const walked = walk(
      chatShape().request,
      { messages: [{ role: 'user', content: 'hei', name: 'kari' }], store: true },
      request,
    );
    expect(walked.problems).toEqual(['messages[0].name: is not allowed', 'store: is not allowed']);
  });

  it('refuses replay state when no adapter declares one', () => {
    const walked = walk(chatShape().request, { messages: [fullChat.messages[2]] }, request);
    expect(walked.problems).toEqual(['messages[0].continuation: is not allowed']);
  });

  it('drops an unknown answer field and counts it', () => {
    const walked = walk(
      chatShape().result,
      {
        content: 'svar',
        toolCalls: [{ id: 'c', name: 'n', arguments: '{}', index: 0 }],
        finishReason: 'stop',
        usage: { inputTokens: 1 },
        servedModel: 'm',
        logprobs: [],
      },
      result,
    );
    expect(walked.problems).toEqual([]);
    expect(walked.dropped).toBe(2);
    expect(walked.value).not.toHaveProperty('logprobs');
  });

  it('refuses a URL or a provider-side object id in an identifier, but not in text', () => {
    const shape = object({ id: ref(), body: text });
    for (const id of [
      'https://evil.example/x',
      'data:image/png;base64,AA',
      'file-abc123',
      'resp_1',
    ])
      expect(walk(shape, { id, body: 'hei' }, request).problems).toHaveLength(1);
    expect(
      walk(shape, { id: 'call_1', body: 'Les https://www.regjeringen.no' }, request).problems,
    ).toEqual([]);
  });

  it('treats an object where text belongs as media', () => {
    const walked = walk(
      embedShape.request,
      ['hei', { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
      request,
    );
    expect(walked.media).toEqual(['[1]']);
  });

  it('masks only text, never identifiers, schemas or the replay state an adapter keeps', () => {
    const walked = walk(chatShape([replay]).request, fullChat, {
      side: 'request',
      map: (t) => t.toUpperCase(),
    });
    const value = walked.value as typeof fullChat;
    expect(value.messages[1]?.content).toBe('FINN OSLO');
    expect(value.messages[2]).toMatchObject({
      toolCalls: [{ id: 'call_1', name: 'search', arguments: '{"Q":"OSLO"}' }],
      continuation: [{ type: 'note', text: 'tenker' }],
    });
    expect(value.tools?.[0]?.description).toBe('See https://docs.example/search');
  });

  it('keeps the decide limits: unique names, letters, digits, _ and - and at most 400 questions', () => {
    const question = (name: string) => ({ type: 'predicate', name, instructions: 'Gjelder det?' });
    const problems = (questions: unknown[]) =>
      walk(decideShape.request, { input: 'hei', questions }, request).problems;
    expect(problems([question('a')])).toEqual([]);
    expect(problems([question('a'), question('a')])).toHaveLength(1);
    expect(problems([question('ikke lov')])).toHaveLength(1);
    expect(
      problems(Array.from({ length: maxDecisionQuestions + 1 }, (_, i) => question(`q${i}`))),
    ).toHaveLength(1);
  });

  it('takes decide input as text or as user messages, and finds media in either', () => {
    const questions = [{ type: 'predicate', name: 'a', instructions: 'Gjelder det?' }];
    const input = (value: unknown) =>
      walk(decideShape.request, { input: value, questions }, request);
    expect(input('hei').problems).toEqual([]);
    expect(input([{ role: 'user', content: 'hei' }]).problems).toEqual([]);
    expect(input([{ role: 'user', content: [{ type: 'input_image' }] }]).media).not.toEqual([]);
    expect(input([{ role: 'system', content: 'hei' }]).problems).not.toEqual([]);
  });

  it('closes rerank to a query and documents', () => {
    expect(walk(rerankShape.request, { query: 'q', documents: ['d'] }, request).problems).toEqual(
      [],
    );
    expect(
      walk(rerankShape.request, { query: 'q', documents: ['d'], top_n: 3 }, request).problems,
    ).toEqual(['top_n: is not allowed']);
  });

  it('refuses a JSON value that is not plain JSON', () => {
    const shape = object({ schema: json, kind: optional(oneOf('a')) });
    expect(walk(shape, { schema: { at: new Date() } }, request).problems).toEqual([
      'schema: must be plain JSON',
    ]);
  });

  it('a URL in a request plain field is refused', () => {
    const shape = object({ value: plain() });
    for (const value of ['https://example.org/cat.png', '  http://10.0.0.1/x', 'blob:abc'])
      expect(walk(shape, { value }, request).problems).toEqual([
        'value: a URL or data URL is not allowed here',
      ]);
    expect(walk(shape, { value: 'See https://example.org for more' }, request).problems).toEqual(
      [],
    );
    expect(walk(shape, { value: 'https://example.org' }, result).problems).toEqual([]);
  });

  it('a data URL or base64 blob in a request plain field is refused', () => {
    const shape = object({ value: plain() });
    expect(walk(shape, { value: 'data:image/png;base64,iVBORw0K' }, request).problems).toEqual([
      'value: a URL or data URL is not allowed here',
    ]);
    const blob = (length: number) => 'iVBORw0KGgo+/_-'.repeat(10).slice(0, length);
    expect(walk(shape, { value: blob(longestBase64Run) }, request).problems).toEqual([]);
    expect(walk(shape, { value: `bilde ${blob(longestBase64Run + 1)}` }, request).problems).toEqual(
      ['value: encoded data such as base64 is not allowed here'],
    );
    expect(walk(shape, { value: blob(200) }, result).problems).toEqual([]);
  });

  it('replay state an adapter keeps passes unread, even when it is encoded', () => {
    const shape = object({ signature: opaque });
    const signature = 'EqQBCkgIARABGAIiQL'.repeat(20);
    expect(walk(shape, { signature }, request)).toMatchObject({
      problems: [],
      value: { signature },
    });
    expect(walk(shape, { signature: 3 }, request).problems).toEqual([
      'signature: must be a string',
    ]);
  });
});

describe('issued ids', () => {
  const id = issued(/^file-[a-z0-9]+$/);

  it('an issued id in a request must be one the provider issued earlier in the call', () => {
    expect(walk(id, 'file-a1', { ...request, issued: new Set(['file-a1']) }).problems).toEqual([]);
    expect(walk(id, 'file-a1', request).problems).toEqual([
      'payload: must be an id the provider issued earlier in this call, never input',
    ]);
    expect(walk(id, 'file-b2', { ...request, issued: new Set(['file-a1']) }).problems).toHaveLength(
      1,
    );
  });

  it('an issued id must match its pattern, and a URL is never one', () => {
    expect(walk(id, 'x/../y', { ...request, issued: new Set(['x/../y']) }).problems[0]).toMatch(
      /must match/,
    );
    const open = issued(/^.+$/);
    expect(
      walk(open, 'https://evil.example', { ...request, issued: new Set(['https://evil.example']) })
        .problems[0],
    ).toMatch(/URL/);
  });

  it('an issued id in an answer needs only its pattern', () => {
    expect(walk(id, 'file-a1', result).problems).toEqual([]);
    expect(walk(id, 'nope', result).problems).toHaveLength(1);
  });
});
