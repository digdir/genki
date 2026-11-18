import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GateError } from '@genai/kernel';
import { memoryLedger } from './contract.js';
import { parseDescriptor } from './descriptor.js';
import { OperationError } from './executor.js';
import { call, json, png, refused } from './kit.test-utils.js';
import { evaluate } from './mapping.js';

const testdata = join(import.meta.dirname, 'testdata', 'descriptors', 'example');
const yamlOf = (name: string) => readFileSync(join(testdata, `${name}.yaml`), 'utf8');
const descriptorOf = (name: string) => parseDescriptor(yamlOf(name));
const text = (s: string) => ({ mediaType: 'text/plain', data: Buffer.from(s).toString('base64') });
const errorOf = (outcome: unknown) => (outcome as { error: Error }).error;

describe('issued ids (A1)', () => {
  const summarize = () => descriptorOf('summarize-file@1');
  const input = { document: text('Hello there'), filename: 'notes.txt' };
  const replies = [json({ id: 'file-a1' }), json({ text: 'A greeting.' }), json({ deleted: true })];

  it('an issued id fills a path segment and a body field only after an answer of the same run issued it', async () => {
    const { sent, outcome } = await call(summarize(), input, replies, {
      endpoint: { ledger: memoryLedger().ledger },
    });
    expect(outcome).toEqual({ result: { summary: 'A greeting.' } });
    expect(sent.map((s) => `${s.init?.method} ${s.url.pathname}`)).toEqual([
      'POST /base/files',
      'POST /base/summaries',
      'DELETE /base/files/file-a1',
    ]);
    expect(JSON.parse(String(sent[1]?.init?.body))).toEqual({
      model: 'model-1',
      file_id: 'file-a1',
    });
  });

  it('an id the answer gives outside the pattern of its issued class fails the call before anything uses it', async () => {
    const { sent, outcome } = await call(summarize(), input, [json({ id: '../../other' })], {
      endpoint: { ledger: memoryLedger().ledger },
    });
    expect(errorOf(outcome).message).toMatch(/bind.file: .*must match/);
    expect(sent).toHaveLength(1);
  });

  it('a body field filled from an issued id is declared issued where it goes out', () => {
    expect(
      refused(
        yamlOf('summarize-file@1').replace(
          "file_id: { issued: '^file-[a-z0-9]+$' }",
          'file_id: plain',
        ),
      ),
    ).toMatch(/file_id: an id the provider issued is declared issued/);
  });

  it('an issued id is neither input nor output', () => {
    expect(
      refused(
        yamlOf('summarize-file@1').replace(
          '    filename?: plain',
          () => "    filename?: plain\n    other?: { issued: '^x$' }",
        ),
      ),
    ).toMatch(/an issued id is neither input nor output/);
    expect(
      refused(
        yamlOf('summarize-file@1').replace(
          '    summary: text',
          () => "    summary: text\n    kept?: { issued: '^x$' }",
        ),
      ),
    ).toMatch(/an issued id is neither input nor output/);
  });

  it('an operation result may not read an issued id', () => {
    expect(
      refused(
        yamlOf('summarize-file@1').replace(
          'summary: $response.text',
          'summary: $steps.upload.file',
        ),
      ),
    ).toMatch(/an id the provider issued stays in the run/);
  });

  it('a provider object id field filled from input is refused', () => {
    expect(
      refused(
        yamlOf('summarize-file@1').replace(
          'file_id: $steps.upload.file',
          'file_id: $input.filename',
        ),
      ),
    ).toMatch(/a provider object id comes only from a value bound in an earlier step/);
  });
});

describe('multipart file names (A2)', () => {
  const run = (filename: string | undefined) =>
    call(
      descriptorOf('summarize-file@1'),
      { document: text('Hello'), ...(filename === undefined ? {} : { filename }) },
      [json({ id: 'file-a1' }), json({ text: 'x' }), json({ deleted: true })],
      { endpoint: { ledger: memoryLedger().ledger } },
    );

  it('a multipart file part is named after its part and media subtype unless the descriptor maps a file name', async () => {
    const { sent } = await run(undefined);
    expect(((sent[0]?.init?.body as FormData).get('file') as File).name).toBe('file.plain');
  });

  it('a file name the descriptor maps is the name of the part', async () => {
    const { sent } = await run('notes.txt');
    expect(((sent[0]?.init?.body as FormData).get('file') as File).name).toBe('notes.txt');
  });

  it('a mapped file name loses any path before it leaves', async () => {
    const { sent } = await run('../../etc/passwd');
    expect(((sent[0]?.init?.body as FormData).get('file') as File).name).toBe(
      '.._.._etc_passwd'.replace(/^\.+/, ''),
    );
  });

  it('a file name for a part that is not media is refused at load', () => {
    expect(
      refused(
        yamlOf('summarize-file@1')
          .replace('        file: $input.filename', '        purpose: $input.filename')
          .replace('          file?: plain', '          purpose?: plain'),
      ),
    ).toMatch(/filenames.purpose names a part that is not media/);
  });

  it('file names belong to a multipart request', () => {
    expect(
      refused(
        yamlOf('describe-image@1').replace(
          '  body:',
          '  filenames:\n    x: $input.question\n  body:',
        ),
      ),
    ).toMatch(/only a multipart request has filenames/);
  });
});

describe('data URLs from media (A3)', () => {
  const describe_ = () => descriptorOf('describe-image@1');
  const input = { picture: png, question: 'What is it?' };

  it('media becomes a data URL in a json body', async () => {
    const { sent, outcome } = await call(describe_(), input, [json({ answer: 'A pixel.' })]);
    expect('result' in outcome).toBe(true);
    expect(JSON.parse(String(sent[0]?.init?.body)).image).toBe(`data:image/png;base64,${png}`);
  });

  it('a data URL field is media for the gate: refused without consent, recorded with it', async () => {
    const refusedCall = await call(describe_(), input, [json({ answer: 'x' })], {
      synthetic: false,
    });
    expect((errorOf(refusedCall.outcome) as unknown as GateError).refusal).toBe('media');
    expect(refusedCall.sent).toEqual([]);
    const allowed = await call(describe_(), input, [json({ answer: 'x' })], {
      synthetic: false,
      unmaskedMedia: ['image/*'],
    });
    expect(allowed.audit[0]?.mediaInput).toEqual([
      expect.objectContaining({ path: 'picture', mediaType: 'image/png', bytes: 70 }),
    ]);
  });

  it('a data URL written into a descriptor is refused at load', () => {
    expect(
      refused(
        yamlOf('describe-image@1').replace(
          '    question: $input.question',
          "    question: { $concat: ['data:image/png;base64,AAAA', $input.question] }",
        ),
      ),
    ).toMatch(/a data URL is built only by \$dataUrl from media/);
  });

  it('a data URL that arrives as input text is refused before anything leaves', async () => {
    const { sent, outcome } = await call(
      describe_(),
      { picture: png, question: 'look: data:image/png;base64,AAAA' },
      [json({ answer: 'x' })],
    );
    expect(errorOf(outcome).message).toMatch(/a data URL is media, which a media field carries/);
    expect(sent).toEqual([]);
  });

  it('$dataUrl belongs in a json body field declared media', () => {
    expect(
      refused(
        yamlOf('describe-image@1').replace(
          '      image: { media: image/png }',
          '      image: text',
        ),
      ),
    ).toMatch(/a data URL carries media, so the field is declared media/);
    expect(
      refused(
        yamlOf('describe-image@1').replace(
          '    model: $deployment',
          '    model: $deployment\n  query:\n    q: { $dataUrl: $input.picture }',
        ),
      ),
    ).toMatch(/\$dataUrl belongs in a json request body only/);
  });
});

describe('credential placement form and basic (A4)', () => {
  const score = () => yamlOf('token-score@1');
  const input = { text: 'hei', questions: [{ name: 'urgent' }], tags: [] };
  const replies = [
    json({ access_token: 'tok-very-secret', expires_in: 60 }),
    json({ answers: [{ name: 'urgent', score: 0.5 }], usage: { tokens: 3 } }),
  ];

  it('a form credential is a named field the gate adds, and no recorded exchange holds it', async () => {
    const yaml = score().replace(
      '    credential:\n      basic: { username: genki-client }',
      '    credential:\n      form: client_secret',
    );
    const { sent, exchanges, outcome } = await call(parseDescriptor(yaml), input, replies);
    expect('result' in outcome).toBe(true);
    const form = sent[0]?.init?.body as URLSearchParams;
    expect(form.get('client_secret')).toBe('connection-key');
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(new Headers(sent[0]?.init?.headers).get('authorization')).toBeNull();
    expect(JSON.stringify(exchanges)).not.toContain('connection-key');
  });

  it('a basic credential has a constant username and the connection credential as password', async () => {
    const { sent } = await call(parseDescriptor(score()), input, replies);
    expect(new Headers(sent[0]?.init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('genki-client:connection-key').toString('base64')}`,
    );
  });

  it('a form credential belongs in a form request', () => {
    expect(
      refused(
        score()
          .replace('basic: { username: genki-client }', 'form: client_secret')
          .replace('      encoding: form\n', ''),
      ),
    ).toMatch(/a credential in a form field belongs in a form request/);
  });

  it('a form field named like the credential is refused', () => {
    expect(
      refused(score().replace('basic: { username: genki-client }', 'form: grant_type')),
    ).toMatch(/is where the credential goes/);
  });

  it('a basic username with a colon or space is refused', () => {
    expect(refused(score().replace('genki-client', 'a:b'))).toMatch(/Invalid string/);
  });
});

describe('usage arithmetic (A5)', () => {
  const scope = { response: { total: 40, audio: 28, text: undefined, price: '2.5' } };

  it('$add, $sub and $mul compute from numbers and numeric text', () => {
    expect(evaluate({ $add: ['$response.total', 2] }, scope)).toBe(42);
    expect(evaluate({ $sub: ['$response.total', '$response.audio'] }, scope)).toBe(12);
    expect(evaluate({ $mul: ['$response.audio', '$response.price'] }, scope)).toBe(70);
  });

  it('arithmetic on a missing value is missing, never zero', () => {
    expect(evaluate({ $sub: ['$response.total', '$response.nothing'] }, scope)).toBeUndefined();
  });

  it('$coalesce takes the first value that is set, zero included', () => {
    expect(evaluate({ $coalesce: ['$response.text', 0, 5] }, scope)).toBe(0);
    expect(evaluate({ $coalesce: ['$response.text', '$response.nothing'] }, scope)).toBeUndefined();
  });

  it('arithmetic refuses what is not a number', () => {
    expect(() => evaluate({ $add: ['$response.total', 'abc'] }, scope)).toThrow(/numbers only/);
    expect(() => evaluate({ $sub: [1, 2, 3] }, scope)).toThrow(/takes a list/);
  });
});

describe('several media types coming back (A7)', () => {
  const link = () => descriptorOf('export-link@1');
  const start = json({ location: 'https://provider.example.test/files/e1.tsv' });

  it('a binary answer within the declared list is kept as a blob of the type the provider gave', async () => {
    const { outcome } = await call(link(), { query: 'x' }, [
      start,
      { type: 'text/tab-separated-values', body: 'a\tb\n' },
    ]);
    expect(outcome).toMatchObject({
      result: { data: { kind: 'media', mediaType: 'text/tab-separated-values', bytes: 4 } },
    });
  });

  it('an answer outside the declared list of media types fails the call', async () => {
    const { outcome } = await call(link(), { query: 'x' }, [
      start,
      { type: 'text/html', body: '<p>' },
    ]);
    expect(errorOf(outcome).message).toMatch(
      /declares a text\/csv or text\/tab-separated-values answer/,
    );
  });
});

describe('a failure condition in until (A8)', () => {
  const failing = () =>
    parseDescriptor(
      yamlOf('transcribe-job@1').replace(
        '      longestSeconds: 30',
        "      longestSeconds: 30\n      fail: { equals: [failed], kind: refused, message: 'the provider could not read the audio' }",
      ),
    );
  const audio = {
    audio: {
      mediaType: 'audio/wav',
      data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=',
    },
  };

  it('a poll that reaches its failure condition fails with the mapped error kind and message, and finally still runs', async () => {
    const { sent, outcome } = await call(
      failing(),
      audio,
      [
        json({ id: 'job_x1', status: 'queued' }),
        json({ id: 'job_x1', status: 'failed' }),
        json({ deleted: true }),
      ],
      { endpoint: { ledger: memoryLedger().ledger } },
    );
    expect(errorOf(outcome)).toBeInstanceOf(OperationError);
    expect(errorOf(outcome)).toMatchObject({
      kind: 'refused',
      message: 'the provider could not read the audio',
    });
    expect(sent.map((s) => s.init?.method)).toEqual(['POST', 'GET', 'DELETE']);
  });

  it('a failure condition names an error kind Genki knows', () => {
    expect(
      refused(
        yamlOf('transcribe-job@1').replace(
          '      longestSeconds: 30',
          '      longestSeconds: 30\n      fail: { equals: [failed], kind: broken }',
        ),
      ),
    ).toMatch(/until.fail.kind/);
  });
});

describe('answer links (C)', () => {
  const link = () => descriptorOf('export-link@1');
  const run = (location: string, endpoint = {}) =>
    call(link(), { query: 'x' }, [json({ location }), { type: 'text/csv', body: 'a,b\n' }], {
      endpoint,
    });

  it('an answer link is followed to the connection host without a second credential from input', async () => {
    const { sent, outcome } = await run('https://provider.example.test/files/e1.csv');
    expect('result' in outcome).toBe(true);
    expect(sent[1]?.url.href).toBe('https://provider.example.test/files/e1.csv');
    expect(new Headers(sent[1]?.init?.headers).get('authorization')).toBe('Bearer connection-key');
  });

  it('an answer link to another host is refused unless the operator lists that host, and carries no credential there', async () => {
    const other = await run('https://files.cdn.test/e1.csv');
    expect(errorOf(other.outcome).message).toMatch(
      /neither the connection's host nor one the operator allows/,
    );
    expect(other.sent).toHaveLength(1);
    const allowed = await run('https://files.cdn.test/e1.csv', {
      allowedHosts: ['files.cdn.test'],
    });
    expect('result' in allowed.outcome).toBe(true);
    expect(new Headers(allowed.sent[1]?.init?.headers).get('authorization')).toBeNull();
  });

  it('an answer link is https and carries no login', async () => {
    expect(errorOf((await run('http://provider.example.test/e1.csv')).outcome).message).toMatch(
      /not https/,
    );
    expect(
      errorOf((await run('https://user:pw@provider.example.test/e1.csv')).outcome).message,
    ).toMatch(/carries a login/);
  });

  it('a redirect from the provider is never followed', async () => {
    const { outcome, sent } = await call(link(), { query: 'x' }, [
      json({ location: 'https://provider.example.test/files/e1.csv' }),
      { status: 302, headers: { location: 'https://evil.example/steal' }, body: {} },
    ]);
    expect('error' in outcome).toBe(true);
    expect(sent.map((s) => s.url.host)).toEqual(['provider.example.test', 'provider.example.test']);
  });

  it('a link never comes from input: following anything but a bound link is refused at load', () => {
    expect(
      refused(yamlOf('export-link@1').replace('follow: $steps.start.link', 'follow: $input.query')),
    ).toMatch(/request.follow/);
    expect(refused(yamlOf('export-link@1').replace('class: url', 'class: plain'))).toMatch(
      /request.follow must be a link an earlier step binds as url/,
    );
  });

  it('a bound link may not be read by a mapping', () => {
    expect(
      refused(
        yamlOf('export-link@1').replace(
          'result:\n  data: $response',
          'result:\n  data: $steps.start.link',
        ),
      ),
    ).toMatch(/result reads \$steps.start.link, which no step binds as a value/);
  });

  it('a step has a path or follows a link, not both', () => {
    expect(
      refused(
        yamlOf('export-link@1').replace(
          '      follow: $steps.start.link',
          '      path: /x\n      follow: $steps.start.link',
        ),
      ),
    ).toMatch(/a request has a path, or follows a link/);
  });
});
