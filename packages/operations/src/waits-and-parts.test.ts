import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateError } from '@genai/kernel';
import { call, json, refused, wav } from './kit.test-utils.js';
import { parseDescriptor } from './descriptor.js';
import type { OperationError } from './executor.js';

const yamlOf = (id: string) =>
  readFileSync(join(import.meta.dirname, 'testdata', 'descriptors', `${id}.yaml`), 'utf8');

const failureOf = (outcome: unknown) => (outcome as { error: OperationError }).error;

describe('until.after: the wait an answer asks for', () => {
  const polled = yamlOf('example/transcribe-job@1')
    .replace(
      '          status: { enum: [queued, running, succeeded, failed] }\n    until:',
      '          status: { enum: [queued, running, succeeded, failed] }\n          poll_after?: number\n    response:\n      headers:\n        x-poll-in: { optional: number }\n    until:',
    )
    .replace('      longestSeconds: 30\n', '      longestSeconds: 120\n')
    .replace(
      '      intervalSeconds: 1\n',
      '      intervalSeconds: 1\n      after: { $coalesce: [$response.poll_after, $headers.x-poll-in] }\n',
    );
  const audio = { audio: { mediaType: 'audio/wav', data: wav } };
  const done = [
    json({ id: 'job_x1', status: 'succeeded' }),
    { type: 'text/plain', body: 'hei' },
    json({ deleted: true }),
  ];

  it('until.after waits as long as a field of the answer asks, never shorter than the interval nor longer than 60 seconds', async () => {
    const { slept, outcome } = await call(parseDescriptor(polled), audio, [
      json({ id: 'job_x1', status: 'queued' }),
      json({ id: 'job_x1', status: 'running', poll_after: 5 }),
      json({ id: 'job_x1', status: 'running', poll_after: 0 }),
      json({ id: 'job_x1', status: 'running', poll_after: 600 }),
      ...done,
    ]);
    expect(outcome).toEqual({ result: { text: 'hei' } });
    expect(slept).toEqual([5000, 1000, 60_000]);
  });

  it('until.after may read a header the step declares, in place of Retry-After', async () => {
    const { slept } = await call(parseDescriptor(polled), audio, [
      json({ id: 'job_x1', status: 'queued' }),
      json({ id: 'job_x1', status: 'running' }, 200, { 'x-poll-in': '7', 'retry-after': '2' }),
      ...done,
    ]);
    expect(slept).toEqual([7000]);
  });

  it('when until.after maps nothing, a Retry-After on the answer is honoured', async () => {
    const { slept } = await call(parseDescriptor(polled), audio, [
      json({ id: 'job_x1', status: 'queued' }),
      json({ id: 'job_x1', status: 'running' }, 200, { 'retry-after': '3' }),
      ...done,
    ]);
    expect(slept).toEqual([3000]);
  });

  it('until.after reads only the answer, so input cannot set the wait', () => {
    expect(
      refused(polled.replace('$response.poll_after, $headers', '$input.language, $headers')),
    ).toMatch(/until: reads \$input, which is not available here/);
  });
});

describe('retryable error statuses', () => {
  const score = (rule: string) =>
    parseDescriptor(
      yamlOf('example/token-score@1')
        .replace(
          '      - { status: 429, kind: rate-limited }\n',
          `      - { status: 429, kind: rate-limited }\n${rule}`,
        )
        .replace(
          'retry: { attempts: 1, longestWaitSeconds: 5 }',
          'retry: { attempts: 3, longestWaitSeconds: 5 }',
        ),
    );
  const retried = score('      - { status: 503, kind: unavailable, retry: true }\n');
  const input = { text: 'hei', questions: [{ name: 'urgent' }], tags: [] };
  const token = json({ access_token: 'tok', expires_in: 60 });
  const answered = json({ answers: [{ name: 'urgent', score: 0.5 }], usage: { tokens: 1 } });
  const busy = (headers: Record<string, string> = {}) =>
    json({ error: { message: 'busy' } }, 503, headers);

  it('an error rule marked retry retries its status after the Retry-After the provider sends', async () => {
    const { outcome, slept } = await call(retried, input, [
      token,
      busy({ 'retry-after': '2' }),
      answered,
    ]);
    expect('result' in outcome).toBe(true);
    expect(slept).toEqual([2000]);
  });

  it("a retryable status without Retry-After backs off 1, 2 and 4 seconds within the step's attempts", async () => {
    const { outcome, slept, sent } = await call(retried, input, [
      token,
      busy(),
      busy(),
      busy(),
      busy(),
    ]);
    expect(failureOf(outcome)).toMatchObject({ status: 503, kind: 'unavailable' });
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(sent).toHaveLength(5);
  });

  it("a retryable status whose Retry-After is beyond the step's cap fails without waiting", async () => {
    const { outcome, slept } = await call(retried, input, [token, busy({ 'retry-after': '30' })]);
    expect(failureOf(outcome)).toMatchObject({ status: 503, kind: 'unavailable' });
    expect(slept).toEqual([]);
  });

  it('a status no rule marks retry is not retried, even with Retry-After', async () => {
    const plain = score('      - { status: 503, kind: unavailable }\n');
    const { outcome, slept } = await call(plain, input, [token, busy({ 'retry-after': '1' })]);
    expect(failureOf(outcome)).toMatchObject({ status: 503, kind: 'unavailable' });
    expect(slept).toEqual([]);
  });
});

describe('a step sent in parts', () => {
  const upload = () => yamlOf('example/chunked-upload@1');
  const pdf = (text: string) => ({
    document: { mediaType: 'application/pdf', data: Buffer.from(text).toString('base64') },
  });
  const etag = (n: number) => `"${String(n).repeat(8)}"`;
  const replies = (parts: number) => [
    json({ upload_id: 'up_1' }),
    ...Array.from({ length: parts }, (_, i) => ({
      type: 'text/plain',
      headers: { etag: etag(i + 1) },
      body: '',
    })),
    json({ bytes: 11 }),
  ];

  it('sends one request per byte range and binds the answers as a list for a later step', async () => {
    const { outcome, sent } = await call(parseDescriptor(upload()), pdf('%PDF-1.7 hi'), replies(3));
    expect(outcome).toEqual({ result: { bytes: 11 } });
    const parts = sent.slice(1, 4);
    expect(parts.map((s) => [s.init?.method, s.url.pathname, s.url.search])).toEqual([
      ['PUT', '/base/documents/up_1/parts', '?partNumber=1&offset=0'],
      ['PUT', '/base/documents/up_1/parts', '?partNumber=2&offset=4'],
      ['PUT', '/base/documents/up_1/parts', '?partNumber=3&offset=8'],
    ]);
    const bodies = await Promise.all(
      parts.map(async (s) => Buffer.from(await (s.init?.body as Blob).arrayBuffer()).toString()),
    );
    expect(bodies).toEqual(['%PDF', '-1.7', ' hi']);
    expect(JSON.parse(String(sent[4]?.init?.body))).toEqual({
      parts: [
        { number: 1, etag: etag(1) },
        { number: 2, etag: etag(2) },
        { number: 3, etag: etag(3) },
      ],
    });
  });

  it('records each part as its media type, size and SHA-256, never its bytes', async () => {
    const { exchanges } = await call(parseDescriptor(upload()), pdf('%PDF-1.7 hi'), replies(3));
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(exchanges[0]?.steps?.[1]?.request.body).toEqual({
      mediaType: 'application/pdf',
      bytes: 4,
      sha256: sha('%PDF'),
    });
  });

  it('a file that needs more parts than the step allows is refused before anything leaves', async () => {
    const { outcome, sent } = await call(parseDescriptor(upload()), pdf('x'.repeat(21)), []);
    expect(failureOf(outcome)).toMatchObject({ kind: 'invalid' });
    expect(failureOf(outcome).message).toMatch(/needs 6 parts of 4 bytes, more than the 5/);
    expect(sent).toEqual([]);
  });

  it('media sent in parts needs the same recorded consent as the whole file', async () => {
    const { outcome, sent } = await call(
      parseDescriptor(upload()),
      pdf('%PDF-1.7 hi'),
      replies(3),
      { synthetic: false },
    );
    expect((outcome as { error: GateError }).error.refusal).toBe('media');
    expect(sent).toEqual([]);
  });

  it('the load check counts one request per step and per part against the 100 a call may make', () => {
    expect(refused(upload().replace('most: 5', 'most: 98'))).toBeUndefined();
    expect(refused(upload().replace('most: 5', 'most: 99'))).toMatch(
      /may need 101 requests with every part, more than the 100 a call may make/,
    );
  });

  it('parts.of reads a media field of the input', () => {
    expect(
      refused(
        upload()
          .replace(
            '    document: { media: application/pdf }',
            '    document: { media: application/pdf }\n    name: text',
          )
          .replace('of: $input.document', 'of: $input.name'),
      ),
    ).toMatch(/parts.of reads a media field of the input/);
  });

  it('$part is read only in a step sent in parts', () => {
    expect(
      refused(
        upload().replace(
          '      path: /documents\n    wire:\n',
          '      path: /documents\n      query: { n: $part.index }\n    wire:\n      query: { object: { n: number } }\n',
        ),
      ),
    ).toMatch(/reads \$part, which is not available here/);
  });

  it('ids the provider issued for each part stay in the run, so the result may not read them', () => {
    expect(
      refused(
        upload()
          .replace('    bytes: number\nsteps:', '    bytes: number\n    parts: [json]\nsteps:')
          .replace(
            '  bytes: $response.bytes\n',
            '  bytes: $response.bytes\n  parts: $steps.send.parts\n',
          ),
      ),
    ).toMatch(/result reads \$steps.send.parts, an id the provider issued stays in the run/);
  });

  it('an issued id is bound from the answer, never from $part', () => {
    expect(
      refused(
        upload().replace(
          '          etag: $headers.etag\n        class:',
          "          etag: { $concat: ['\"', $part.body.mediaType, '\"'] }\n        class:",
        ),
      ),
    ).toMatch(/bind.parts: an issued id comes from the answer, never from \$part/);
  });

  it('a step sent in parts binds values, never a secret or a link', () => {
    expect(
      refused(
        upload().replace(
          '        class:\n          object:\n            number: number\n            etag: { issued: \'^"[0-9a-f]{8}"$\' }\n',
          '        class: url\n',
        ),
      ),
    ).toMatch(/bind.parts: a step sent in parts binds values only/);
  });

  it('a finally step is never sent in parts', () => {
    expect(
      refused(
        `${upload()}finally:\n  - name: abort\n    parts: { of: $input.document, bytes: 4, most: 2 }\n    request:\n      method: DELETE\n      path: /documents/{steps.start.upload}\n    wire:\n      response: { object: { ok: boolean } }\n`,
      ),
    ).toMatch(/step abort: a finally step is one request/);
  });

  it('an optional media input that is absent cannot be sent in parts', async () => {
    const optional = parseDescriptor(
      upload().replace(
        '    document: { media: application/pdf }',
        '    document?: { media: application/pdf }',
      ),
    );
    const { outcome, sent } = await call(optional, {}, replies(0));
    expect(failureOf(outcome)).toMatchObject({ kind: 'invalid' });
    expect(failureOf(outcome).message).toMatch(/has no media to send in parts/);
    expect(sent).toEqual([]);
  });

  it('a step sent in parts does not poll', () => {
    expect(
      refused(
        upload().replace(
          '    errors:\n      - { status: 503',
          '    until: { test: $response, intervalSeconds: 1, longestSeconds: 5 }\n    errors:\n      - { status: 503',
        ),
      ),
    ).toMatch(/one plain request per part, without until/);
  });
});
