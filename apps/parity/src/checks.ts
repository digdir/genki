import type { Captured, JsonValue, StepResult } from './types.js';

type Json = Record<string, JsonValue>;

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const dataFrames = (response: Captured): JsonValue[] =>
  (response.frames ?? []).flatMap((f) =>
    f.kind === 'data' && typeof f.data !== 'string' ? [f.data] : [],
  );

export const toolResult = (response: Captured): Json | undefined => {
  const last = isObject(response.body) ? response.body : dataFrames(response).at(-1);
  return isObject(last) && isObject(last.result) ? last.result : undefined;
};

const chunksOf = (result: Json | undefined): Json[] => {
  const structured = result?.structuredContent;
  return isObject(structured) && Array.isArray(structured.chunks)
    ? structured.chunks.filter(isObject)
    : [];
};

const answerOf = (result: Json | undefined) => {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.find((c) => isObject(c) && c.type === 'text');
  return isObject(text) && typeof text.text === 'string' ? text.text : '';
};

export const answered = (response: Captured): string[] => {
  const result = toolResult(response);
  if (!result) return ['no tools/call result'];
  return result.isError === true ? [`the call failed: ${answerOf(result)}`] : [];
};

export const noChunks = (response: Captured): string[] => {
  const problems = answered(response);
  const n = chunksOf(toolResult(response)).length;
  return n > 0 ? [...problems, `a filter that matches nothing returned ${n} chunks`] : problems;
};

export const noPageMarkers = (response: Captured): string[] =>
  chunksOf(toolResult(response)).flatMap((c) =>
    typeof c.content_markdown === 'string' && /\{\d+\}/.test(c.content_markdown)
      ? [`chunk ${String(c.chunk_id)} carries a page marker`]
      : [],
  );

export const citationsResolveByDocument = (response: Captured): string[] => {
  const result = toolResult(response);
  const documents = new Set(
    chunksOf(result).flatMap((c) => {
      const key = c.doc_num || c.url;
      return typeof key === 'string' && key !== '' ? [key] : [];
    }),
  ).size;
  const cited = [...answerOf(result).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  return cited
    .filter((n) => n < 1 || n > documents)
    .map((n) => `[${n}] has no source among ${documents} documents`);
};

export const callerFilterReported = (response: Captured): string[] => {
  const structured = toolResult(response)?.structuredContent;
  const applied = isObject(structured) ? structured.filters_applied : undefined;
  const found =
    Array.isArray(applied) &&
    applied.some(
      (a) =>
        isObject(a) &&
        (a.source === 'explicit' || a.source === 'merged') &&
        JSON.stringify(a.filter).includes('"type"'),
    );
  return found ? [] : ['filters_applied does not report the caller filter'];
};

export const streamsBeforeResult = (response: Captured): string[] => {
  const frames = dataFrames(response);
  const events = frames.flatMap((f) => {
    const params = isObject(f) ? f.params : undefined;
    const meta = isObject(params) ? params._meta : undefined;
    return isObject(meta) && typeof meta.event === 'string' ? [meta.event] : [];
  });
  const missing = ['agent/iteration-started', 'agent/turn-completed', 'response/chunk'].filter(
    (e) => !events.includes(e),
  );
  return missing.map((e) => `no ${e} progress frame before the result`);
};

export type Check = (response: Captured, previous: StepResult[]) => string[];

export const all =
  (...checks: Check[]) =>
  (response: Captured, previous: StepResult[] = []) =>
    checks.flatMap((check) => check(response, previous));

export const createdConversationId = (step: StepResult | undefined): string | undefined => {
  const body = isObject(step?.response.body) ? step.response.body : undefined;
  const nested = isObject(body?.conversation) ? body.conversation : undefined;
  const id = body?.id ?? body?.['conversation-id'] ?? body?.conversation_id ?? nested?.id;
  return typeof id === 'string' ? id : undefined;
};

const metaOf = (response: Captured) => {
  const meta = toolResult(response)?._meta;
  return isObject(meta) ? meta : undefined;
};

export const staysInConversation: Check = (response, previous) => {
  const wanted = createdConversationId(previous[0]);
  const got = metaOf(response)?.conversation_id;
  return wanted !== undefined && got === wanted
    ? []
    : [
        `the answer belongs to conversation ${String(got)}, not the one created (${String(wanted)})`,
      ];
};

const documentsOf = (response: Captured) =>
  new Set(
    chunksOf(toolResult(response)).flatMap((c) => {
      const key = c.doc_num ?? c.url;
      return typeof key === 'string' || typeof key === 'number' ? [String(key)] : [];
    }),
  );

const titlesOf = (response: Captured) =>
  chunksOf(toolResult(response)).flatMap((c) =>
    typeof c.title === 'string' && c.title.length >= 8 ? [c.title.toLowerCase()] : [],
  );

export const followUpUsesFirst: Check = (response, previous) => {
  const first = previous.at(-1)?.response;
  if (!first) return ['no first turn to compare with'];
  if (metaOf(response)?.status === 'needs-clarification')
    return ['the follow-up asks for clarification, so the first turn did not reach it'];
  const earlier = documentsOf(first);
  const shared = [...documentsOf(response)].some((d) => earlier.has(d));
  const text = answerOf(toolResult(response)).toLowerCase();
  const named = titlesOf(first).some((t) => text.includes(t));
  return shared || named
    ? []
    : ['the follow-up neither cites a document from the first turn nor names one of its sources'];
};

export const threadHasTurns =
  (questions: string[]): Check =>
  (response) => {
    const body = isObject(response.body) ? response.body : undefined;
    const messages = (Array.isArray(body?.messages) ? body.messages : [])
      .filter(isObject)
      .filter((m) => m.role === 'user' || m.role === 'assistant');
    const roles = messages.map((m) => String(m.role));
    const expected = questions.flatMap(() => ['user', 'assistant']);
    const problems: string[] = [];
    if (JSON.stringify(roles) !== JSON.stringify(expected))
      problems.push(
        `the thread has roles [${roles.join(', ')}], expected [${expected.join(', ')}]`,
      );
    questions.forEach((q, i) => {
      const user = messages[i * 2];
      const assistant = messages[i * 2 + 1];
      if (user && user.text !== q)
        problems.push(`turn ${i + 1} stores ${JSON.stringify(user.text)} as the question`);
      if (assistant && (typeof assistant.text !== 'string' || assistant.text.trim() === ''))
        problems.push(`turn ${i + 1} stores an empty answer`);
    });
    return problems;
  };
