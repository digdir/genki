import { isLocale, type Locale } from '@genai/i18n';
import {
  failureFromAnswer,
  failureFromHttp,
  failureFromStreamError,
  type RunError,
} from './failures';
import { translator } from './i18n';
import { detectLang } from './language';
import { tableFrom, type ResultTable } from './ResultTable';
import { withPlausibleYears } from './years';
import type {
  ChatMessage,
  ChatReply,
  ConversationSummary,
  DocumentRules,
  FeedbackInput,
  InputField,
  ServiceOption,
  Source,
  FailedRun,
  TableReview,
  WorkspaceApi,
  WrittenStandard,
} from './types';

const humanDescription = (description?: string) =>
  description?.split(' Multi-turn: ')[0]?.trim() ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch: typeof fetch;
  token: () => string | undefined;
  locale?: () => Locale;
}

const reviewFrom = (body: Record<string, unknown> | undefined): TableReview => {
  const table = tableFrom(body?.table);
  return {
    ...(typeof body?.service === 'string' ? { service: body.service } : {}),
    ...(typeof body?.createdAt === 'string' ? { createdAt: body.createdAt } : {}),
    ...(body?.input && typeof body.input === 'object' && !Array.isArray(body.input)
      ? { input: body.input as Record<string, unknown> }
      : {}),
    ...(table ? { table } : {}),
    ...(typeof body?.csv === 'string' ? { csv: body.csv } : {}),
    edits: Array.isArray(body?.edits) ? (body.edits as TableReview['edits']) : [],
    approval:
      (body?.approval as TableReview['approval'] | undefined)?.status === 'approved'
        ? (body?.approval as TableReview['approval'])
        : { status: 'draft' },
  };
};

interface ModelEntry {
  id: string;
  name?: string;
  title?: string;
  description?: string;
  status?: string;
  _status?: string;
  status_reason?: string;
  input_fields?: InputField[];
  _chat?: boolean;
  _batch?: boolean;
  _documents?: { accepts?: unknown; max_bytes?: unknown; max_count?: unknown };
}

const documentRulesOf = (m: ModelEntry): DocumentRules | undefined => {
  const d = m._documents;
  const accepts = Array.isArray(d?.accepts)
    ? d.accepts.filter((a): a is string => typeof a === 'string')
    : [];
  return accepts.length && typeof d?.max_bytes === 'number' && typeof d.max_count === 'number'
    ? { accepts, maxBytes: d.max_bytes, maxCount: d.max_count }
    : undefined;
};

interface OwuiSource {
  source?: { name?: string; id?: string; url?: string };
  metadata?: { name?: string }[];
  excerpt?: string;
  excerpts?: { chunk_id?: string; text?: string }[];
  index?: number;
  version?: string | number;
  published_at?: string;
}

interface Chunk {
  choices?: {
    delta?: { content?: string; refusal?: string };
    finish_reason?: string | null;
  }[];
  sources?: OwuiSource[];
  citations?: string[];
  retract?: boolean;
  no_answer?: boolean;
  error?: RunError;
  table?: unknown;
  csv?: string;
}

const linkable = (url: string | undefined) =>
  url && /^https?:\/\//.test(url) ? { url } : ({} as { url?: string });

const passageLength = 1200;

const passageOf = (s: OwuiSource) => {
  const cited = s.excerpts?.find((e) => e.chunk_id === s.source?.id && e.text?.trim());
  const text = (cited?.text ?? s.excerpt ?? '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > passageLength ? `${text.slice(0, passageLength).trimEnd()}…` : text;
};

export const sourcesFrom = (chunk: Chunk, locale: Locale = 'nb'): Source[] => {
  if (chunk.sources?.length)
    return chunk.sources.map((s) => ({
      title: s.metadata?.[0]?.name ?? s.source?.name ?? translator(locale)('api.untitledSource'),
      ...linkable(s.source?.url),
      ...(passageOf(s) ? { excerpt: passageOf(s) as string } : {}),
      ...(typeof s.index === 'number' ? { index: s.index } : {}),
      ...(s.version !== undefined && s.version !== '' ? { version: String(s.version) } : {}),
      ...(s.published_at ? { publishedAt: s.published_at } : {}),
    }));
  return (chunk.citations ?? []).map((url, i) => ({ title: url, index: i + 1, ...linkable(url) }));
};

export const serviceName = (id: string) => {
  const bare = id.slice(id.lastIndexOf('/') + 1).replace(/__default$/, '');
  const words = bare.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
};

const readJson = async (response: Response) => response.json().catch(() => undefined);

export async function* sseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = done ? '' : (events.pop() ?? '');
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
    if (done) return;
  }
}

export const createWorkspaceApi = ({
  baseUrl,
  fetch: send,
  token,
  locale = () => 'nb',
}: ApiClientOptions): WorkspaceApi => {
  const t = () => translator(locale());
  const headers = (extra: Record<string, string> = {}) => {
    const bearer = token();
    return {
      accept: 'application/json',
      'accept-language': locale(),
      ...extra,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    };
  };

  const tenantCall = async (
    method: string,
    tenant: string,
    path: string,
    options: { body?: unknown; reason?: string; signal?: AbortSignal | undefined } = {},
  ) => {
    const response = await send(`${baseUrl}/tenants/${encodeURIComponent(tenant)}/${path}`, {
      method,
      headers: headers({
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.reason ? { 'change-reason': encodeURIComponent(options.reason) } : {}),
      }),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const body = (await readJson(response)) as Record<string, unknown> | undefined;
    if (!response.ok) throw new ApiError(response.status, body);
    return body;
  };
  const review = (task: string, rest = '') => `tasks/${encodeURIComponent(task)}/review${rest}`;

  return {
    rights: async (tenant, signal) => {
      try {
        const rights = (await tenantCall('GET', tenant, 'me', { signal }))?.rights;
        return Array.isArray(rights)
          ? rights.filter((r): r is string => typeof r === 'string')
          : [];
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) return [];
        throw error;
      }
    },
    writtenStandard: async (tenant, signal) => {
      const value = (await tenantCall('GET', tenant, 'me/preferences', { signal }))
        ?.writtenStandard;
      return value === 'bokmal' || value === 'nynorsk' ? value : 'user';
    },
    setWrittenStandard: async (tenant, value: WrittenStandard) => {
      await tenantCall('PUT', tenant, 'me/preferences', {
        body: { writtenStandard: value === 'user' ? null : value },
        reason: t()('api.standardReason'),
      });
    },
    language: async (tenant, signal) => {
      const value = (await tenantCall('GET', tenant, 'me/preferences', { signal }))?.language;
      return isLocale(value) ? value : null;
    },
    setLanguage: async (tenant, value) => {
      await tenantCall('PUT', tenant, 'me/preferences', {
        body: { language: value },
        reason: t()('api.languageReason'),
      });
    },
    tableReview: async (tenant, task, signal) =>
      reviewFrom(await tenantCall('GET', tenant, review(task), { signal })),
    saveTableEdits: async (tenant, task, edits) =>
      reviewFrom(
        await tenantCall('PUT', tenant, review(task, '/edits'), {
          body: { edits },
          reason: t()('api.tableEditReason'),
        }),
      ),
    approveTable: async (tenant, task) =>
      reviewFrom(
        await tenantCall('POST', tenant, review(task, '/approve'), {
          body: {},
          reason: t()('api.tableApproveReason'),
        }),
      ),
    failedRuns: async (tenant, signal) => {
      const response = await send(
        `${baseUrl}/tenants/${encodeURIComponent(tenant)}/tasks/mine?status=failed`,
        { headers: headers(), ...(signal ? { signal } : {}) },
      );
      if (!response.ok) throw new ApiError(response.status, await readJson(response));
      const body = (await readJson(response)) as
        | {
            data?: {
              id: string;
              service: string;
              serviceName?: string;
              createdAt: string;
              failure?: { reason?: string; step?: string };
            }[];
          }
        | undefined;
      return (body?.data ?? []).map((r): FailedRun => ({
        id: r.id,
        service: r.service,
        ...(r.serviceName ? { serviceName: r.serviceName } : {}),
        at: r.createdAt,
        reason: r.failure?.reason ?? t()('api.runFailed'),
        ...(r.failure?.step ? { step: r.failure.step } : {}),
      }));
    },
    listServices: async (signal) => {
      const response = await send(`${baseUrl}/v1/models`, {
        headers: headers(),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok) throw new ApiError(response.status, await readJson(response));
      const body = (await response.json()) as { data: ModelEntry[] };
      return body.data
        .filter((m) => m._chat === true)
        .map((m): ServiceOption => ({
          id: m.id,
          name: m.title ?? m.name ?? serviceName(m.id),
          ...(humanDescription(m.description)
            ? { description: humanDescription(m.description) }
            : {}),
          ...(m.input_fields?.length
            ? { inputFields: m.input_fields.map((f) => withPlausibleYears(f)) }
            : {}),
          ...(m._batch === true ? { batch: true } : {}),
          ...(documentRulesOf(m) ? { documents: documentRulesOf(m) as DocumentRules } : {}),
          ...((m.status ?? m._status) === 'paused'
            ? {
                paused: true,
                ...(m.status_reason?.trim() ? { pausedReason: m.status_reason.trim() } : {}),
              }
            : {}),
        }));
    },

    conversations: {
      list: async (signal) => {
        const response = await send(`${baseUrl}/api/conversations?page_size=30`, {
          headers: headers(),
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) throw new ApiError(response.status, await readJson(response));
        const body = (await readJson(response)) as
          { conversations?: Record<string, unknown>[] } | undefined;
        return (body?.conversations ?? []).map((c): ConversationSummary => ({
          id: String(c.id),
          title: typeof c.topic === 'string' ? c.topic : '',
          agentId: typeof c.agentId === 'string' ? c.agentId : '',
          created: typeof c.created === 'string' ? c.created : '',
        }));
      },
      messages: async (id, signal) => {
        const response = await send(`${baseUrl}/api/conversations/${encodeURIComponent(id)}`, {
          headers: headers(),
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) throw new ApiError(response.status, await readJson(response));
        const body = (await readJson(response)) as
          { messages?: Record<string, unknown>[] } | undefined;
        return (body?.messages ?? []).map((m, i): ChatMessage => {
          const text = typeof m.text === 'string' ? m.text : '';
          if (m.role !== 'assistant')
            return {
              id: `saved-${i}`,
              role: 'user',
              text,
              lang: detectLang(text),
              ...(Array.isArray(m.attachments) && m.attachments.length
                ? { attachments: m.attachments.filter((a): a is string => typeof a === 'string') }
                : {}),
            };
          const chunks = Array.isArray(m.chunks) ? (m.chunks as Record<string, unknown>[]) : [];
          return {
            id: `saved-${i}`,
            role: 'assistant',
            text,
            lang: detectLang(text),
            ...(typeof m.task === 'string' && m.task ? { task: m.task } : {}),
            sources: chunks.map((c, n) => ({
              title:
                typeof c.docTitle === 'string' && c.docTitle
                  ? c.docTitle
                  : translator(locale())('api.untitledSource'),
              index: n + 1,
              ...(typeof c.contentMarkdown === 'string' && c.contentMarkdown.trim()
                ? { excerpt: c.contentMarkdown.replace(/\s+/g, ' ').trim().slice(0, 1200) }
                : {}),
            })),
          };
        });
      },
      rename: async (id, title) => {
        const response = await send(`${baseUrl}/api/conversations/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ title }),
        });
        if (!response.ok) throw new ApiError(response.status, await readJson(response));
      },
    },

    chat: async (
      service,
      history,
      onDelta,
      signal,
      input,
      conversation,
      documents,
    ): Promise<ChatReply> => {
      let response: Response;
      try {
        response = await send(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
          body: JSON.stringify({
            model: service,
            messages: history,
            stream: true,
            genai_stream: 'live',
            ...(input ? { input } : {}),
            ...(documents?.length
              ? {
                  genai_documents: documents.map((d) => ({
                    name: d.name,
                    media_type: d.mediaType,
                    data: d.data,
                  })),
                }
              : {}),
            ...(conversation
              ? conversation.id
                ? { conversation_id: conversation.id }
                : { genai_conversation: true }
              : {}),
          }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        return { text: '', sources: [], failure: { kind: 'unavailable' } };
      }
      const task = response.headers.get('genai-task') ?? undefined;
      const conversationId = response.headers.get('genai-conversation') ?? undefined;
      if (!response.ok || !response.body)
        return {
          text: '',
          sources: [],
          failure: failureFromHttp(response.status, await readJson(response)),
        };

      let text = '';
      let sources: Source[] = [];
      let refusal = '';
      let finish: string | null | undefined;
      let noAnswer = false;
      let table: ResultTable | undefined;
      let csv: string | undefined;
      let runError: RunError | undefined;
      for await (const data of sseEvents(response.body)) {
        if (data === '[DONE]') break;
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          continue;
        }
        if (chunk.sources || chunk.citations) sources = sourcesFrom(chunk, locale());
        if (chunk.retract) {
          text = '';
          onDelta(text);
        }
        if (chunk.no_answer) noAnswer = true;
        if (chunk.error) runError = chunk.error;
        if (chunk.table) {
          table = tableFrom(chunk.table);
          if (typeof chunk.csv === 'string') csv = chunk.csv;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.refusal) refusal += choice.delta.refusal;
        if (choice?.delta?.content) {
          text += choice.delta.content;
          if (choice.finish_reason !== 'error' && !text.startsWith('Error: ') && !table)
            onDelta(text);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
      }
      const withTask = {
        ...(task ? { task } : {}),
        ...(conversationId ? { conversationId } : {}),
      };
      if (finish === 'error')
        return {
          text: '',
          sources: [],
          failure: failureFromStreamError(text, runError),
          ...withTask,
        };
      if (refusal || finish === 'content_filter')
        return {
          text: '',
          sources: [],
          failure: { kind: 'refused', ...(refusal || text ? { message: refusal || text } : {}) },
          ...withTask,
        };
      const failure = failureFromAnswer(text);
      if (failure) return { text: '', sources: [], failure, ...withTask };
      return {
        text,
        sources,
        ...(noAnswer ? { noAnswer } : {}),
        ...(table ? { table, ...(csv ? { csv } : {}) } : {}),
        ...withTask,
      };
    },

    sendFeedback: async ({ task, rating, reasons, comment }: FeedbackInput) => {
      if (!task) throw new Error('the answer has no task to attach feedback to');
      const response = await send(`${baseUrl}/api/feedback`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          task,
          rating,
          ...(reasons.length ? { reasons } : {}),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
        }),
      });
      if (!response.ok) throw new ApiError(response.status, await readJson(response));
    },
  };
};
