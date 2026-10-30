import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { judgeTraceIdOf, langfuseTraceSink } from './sink.js';

const host = process.env.LANGFUSE_LOCAL_URL;
const publicKey = process.env.LANGFUSE_LOCAL_PUBLIC_KEY ?? 'pk-lf-genki-test';
const secretKey = process.env.LANGFUSE_LOCAL_SECRET_KEY ?? 'sk-lf-genki-test';

const hex = () => randomBytes(16).toString('hex');

const ingest = async (batch: Record<string, unknown>[]) => {
  const response = await fetch(new URL('/api/public/ingestion', host), {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ batch }),
  });
  expect(response.status).toBeLessThan(300);
};

const eventually = async <T>(read: () => Promise<T>, done: (value: T) => boolean) => {
  let value = await read();
  for (let i = 0; i < 60 && !done(value); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    value = await read();
  }
  return value;
};

describe('finding the judges of a trace', () => {
  it('reads every page of scores and of targeting traces, so a judge on a later page is found', async () => {
    const asked: string[] = [];
    const fake: typeof fetch = async (input) => {
      const url = new URL(String(input));
      asked.push(
        `${url.pathname}?${url.searchParams.get('page') ?? url.searchParams.get('cursor') ?? ''}`,
      );
      if (url.pathname === '/api/public/v3/scores')
        return Response.json(
          url.searchParams.get('cursor') === 'neste'
            ? { data: [{ metadata: { job_execution_id: 'jobb-2' } }], meta: {} }
            : { data: [{ metadata: { job_execution_id: 'jobb-1' } }], meta: { cursor: 'neste' } },
        );
      const page = Number(url.searchParams.get('page'));
      return Response.json({ data: [{ id: `mål-${page}` }], meta: { page, totalPages: 2 } });
    };
    const sink = langfuseTraceSink({
      host: 'https://langfuse.etaten.example.no',
      publicKey: 'pk',
      secretKey: 'sk',
      fetch: fake,
    });

    const judges = await sink.judgeTraces('sak');

    expect(judges.sort()).toEqual(
      [judgeTraceIdOf('jobb-1'), judgeTraceIdOf('jobb-2'), 'mål-1', 'mål-2'].sort(),
    );
    expect(asked).toEqual([
      '/api/public/v3/scores?',
      '/api/public/v3/scores?neste',
      '/api/public/traces?1',
      '/api/public/traces?2',
    ]);
  });
});

describe.skipIf(!host)('deleting from a local Langfuse 4.4.0 (dual write mode)', () => {
  it("finds the judges' traces by score and by target, deletes them and the case's trace, and leaves nothing", async () => {
    const sink = langfuseTraceSink({ host: host as string, publicKey, secretKey });
    const now = new Date().toISOString();
    const caseTrace = hex();
    const targetedJudge = hex();
    const execution = randomUUID();
    const scoredJudge = judgeTraceIdOf(execution);
    const judge = { environment: 'langfuse-llm-as-a-judge', name: 'kudos_quotes_covered' };
    await ingest([
      {
        id: randomUUID(),
        type: 'trace-create',
        timestamp: now,
        body: { id: caseTrace, name: 'svar', timestamp: now },
      },
      {
        id: randomUUID(),
        type: 'trace-create',
        timestamp: now,
        body: {
          id: targetedJudge,
          timestamp: now,
          ...judge,
          metadata: { target_trace_id: caseTrace },
        },
      },
      {
        id: randomUUID(),
        type: 'trace-create',
        timestamp: now,
        body: { id: scoredJudge, timestamp: now, ...judge },
      },
      {
        id: randomUUID(),
        type: 'score-create',
        timestamp: now,
        body: {
          id: randomUUID(),
          traceId: caseTrace,
          name: 'kudos_quotes_covered',
          value: 1,
          dataType: 'NUMERIC',
          environment: judge.environment,
          metadata: { job_execution_id: execution },
        },
      },
    ]);

    const judges = await eventually(
      () => sink.judgeTraces(caseTrace),
      (found) => found.length >= 2,
    );
    for (const id of judges) await sink.deleteTrace(id);
    await sink.deleteTrace(caseTrace);
    const left = await eventually(
      async () => [...(await sink.remaining(caseTrace)), ...(await sink.remaining(scoredJudge))],
      (found) => found.length === 0,
    );

    expect(judges.sort()).toEqual([scoredJudge, targetedJudge].sort());
    expect(left).toEqual([]);
  }, 150_000);
});
