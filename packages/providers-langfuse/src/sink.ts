import { createHash } from 'node:crypto';

export interface LangfuseSinkOptions {
  host: string;
  publicKey: string;
  secretKey: string;
  fetch?: typeof fetch;
}

/** Langfuse names a judge's execution trace by the first 32 hex characters of sha256(job_execution_id). */
export const judgeTraceIdOf = (jobExecutionId: string) =>
  createHash('sha256').update(jobExecutionId).digest('hex').slice(0, 32);

const targetFilter = (trace: string) =>
  JSON.stringify([
    {
      type: 'stringObject',
      column: 'metadata',
      key: 'target_trace_id',
      operator: '=',
      value: trace,
    },
  ]);

/**
 * Deletes what genki sent to a Langfuse and what its judges made from it (ADR 0040). Judge traces
 * are found through the scores on the case's trace and through traces that name it as their target,
 * so a judge call that wrote no score is found too.
 */
export const langfuseTraceSink = (options: LangfuseSinkOptions) => {
  const send = options.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64')}`;
  const call = (path: string, init: RequestInit = {}) =>
    send(new URL(path, options.host), { ...init, headers: { authorization, ...init.headers } });
  const json = async <T>(path: string): Promise<T> => {
    const response = await call(path);
    if (!response.ok)
      throw new Error(`Langfuse answered HTTP ${response.status} for ${path.split('?')[0]}`);
    return (await response.json()) as T;
  };

  /**
   * The traces whose observations name a trace as their target, from every page. The v2
   * observations API answers in every write mode; the traces list is off in events_only.
   */
  const targeting = async (trace: string) => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const found = await json<{ data: { traceId: string }[]; meta?: { cursor?: string } }>(
        `/api/public/v2/observations?fields=core&limit=100&filter=${encodeURIComponent(targetFilter(trace))}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      );
      for (const o of found.data) ids.add(o.traceId);
      cursor = found.data.length > 0 ? found.meta?.cursor : undefined;
    } while (cursor);
    return [...ids];
  };

  /** Every page: v3 scores are paged by cursor. */
  const scored = async (trace: string) => {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const found = await json<{
        data: { metadata?: Record<string, unknown> }[];
        meta?: { cursor?: string };
      }>(
        `/api/public/v3/scores?traceId=${encodeURIComponent(trace)}&fields=details&limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      );
      for (const s of found.data)
        if (typeof s.metadata?.job_execution_id === 'string')
          ids.push(judgeTraceIdOf(s.metadata.job_execution_id));
      cursor = found.data.length > 0 ? found.meta?.cursor : undefined;
    } while (cursor);
    return ids;
  };

  /** A trace is there while it has an observation, read as targeting is, in every write mode. */
  const exists = async (trace: string) =>
    (
      await json<{ data: unknown[] }>(
        `/api/public/v2/observations?fields=core&limit=1&traceId=${encodeURIComponent(trace)}`,
      )
    ).data.length > 0;

  return {
    exists,
    judgeTraces: async (trace: string) =>
      [...new Set([...(await scored(trace)), ...(await targeting(trace))])].filter(
        (id) => id !== trace,
      ),
    deleteTrace: async (trace: string) => {
      const response = await call(`/api/public/traces/${encodeURIComponent(trace)}`, {
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 404)
        throw new Error(`Langfuse answered HTTP ${response.status} deleting a trace`);
    },
    remaining: async (trace: string) => [
      ...((await exists(trace)) ? [trace] : []),
      ...(await targeting(trace)),
    ],
  };
};
