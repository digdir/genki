import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestHash, startPlayback, type Playback } from './playback.js';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

const upstream = async (
  reply: (body: Record<string, unknown>) => { contentType: string; text: string },
) => {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  let calls = 0;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      calls++;
      seen.push({ path: req.url ?? '', headers: req.headers });
      const r = reply(JSON.parse(raw) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': r.contentType });
      res.end(r.text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`,
    seen,
    calls: () => calls,
  };
};

const started = async (p: Promise<Playback>) => {
  const playback = await p;
  closers.push(() => playback.close());
  return playback;
};

const chat = (url: string, body: Record<string, unknown>) =>
  fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-key-not-stored' },
    body: JSON.stringify(body),
  });

const question = (model: string, content = 'Hva er Kudos?') => ({
  model,
  messages: [{ role: 'user', content }],
  temperature: 0.1,
});

describe('playback stub', () => {
  it('records through the upstream with its own key, and never writes keys to the cassette', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playback-'));
    const cassette = join(dir, 'cassette.json');
    const llm = await upstream(() => ({
      contentType: 'application/json',
      text: JSON.stringify({
        id: 'chatcmpl-1',
        choices: [{ message: { role: 'assistant', content: 'Kudos er ...' } }],
      }),
    }));
    const recorder = await started(
      startPlayback({
        mode: 'record',
        cassette,
        upstream: { baseUrl: llm.url, apiKey: 'upstream-secret', auth: 'api-key' },
      }),
    );

    const response = await chat(recorder.url, { ...question('gpt-4o'), api_key: 'leaked-in-body' });

    expect(((await response.json()) as { id: string }).id).toBe('chatcmpl-1');
    expect(llm.seen[0]).toMatchObject({
      path: '/openai/v1/chat/completions',
      headers: { 'api-key': 'upstream-secret' },
    });
    expect(llm.seen[0]?.headers.authorization).toBeUndefined();
    const text = await readFile(cassette, 'utf8');
    for (const secret of ['upstream-secret', 'client-key-not-stored', 'leaked-in-body'])
      expect(text).not.toContain(secret);
  });

  it('replays by request content whatever model name each system sends, in recorded order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playback-'));
    const cassette = join(dir, 'cassette.json');
    let n = 0;
    const llm = await upstream(() => ({
      contentType: 'application/json',
      text: JSON.stringify({ answer: ++n }),
    }));
    const recorder = await started(
      startPlayback({
        mode: 'record',
        cassette,
        upstream: { baseUrl: llm.url, apiKey: 'k', auth: 'bearer' },
      }),
    );
    await chat(recorder.url, question('headless-deployment'));
    await chat(recorder.url, question('headless-deployment'));
    await recorder.close();

    const player = await started(startPlayback({ mode: 'replay', cassette }));
    const first = (await (await chat(player.url, question('platform-model-id'))).json()) as {
      answer: number;
    };
    const second = (await (await chat(player.url, question('platform-model-id'))).json()) as {
      answer: number;
    };
    const third = (await (await chat(player.url, question('platform-model-id'))).json()) as {
      answer: number;
    };

    expect([first.answer, second.answer, third.answer]).toEqual([1, 2, 2]);
    expect(llm.calls()).toBe(2);
  });

  it('replays a streamed answer as the same event stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playback-'));
    const cassette = join(dir, 'cassette.json');
    const sse = 'data: {"choices":[{"delta":{"content":"Hei"}}]}\n\ndata: [DONE]\n\n';
    const llm = await upstream(() => ({ contentType: 'text/event-stream', text: sse }));
    const recorder = await started(
      startPlayback({
        mode: 'record',
        cassette,
        upstream: { baseUrl: llm.url, apiKey: 'k', auth: 'bearer' },
      }),
    );
    await chat(recorder.url, { ...question('m'), stream: true });
    await recorder.close();

    const player = await started(startPlayback({ mode: 'replay', cassette }));
    const replayed = await chat(player.url, { ...question('m'), stream: true });

    expect(replayed.headers.get('content-type')).toBe('text/event-stream');
    expect(await replayed.text()).toBe(sse);
  });

  it('answers an unrecorded request with a clear miss instead of inventing output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'playback-'));
    const player = await started(
      startPlayback({ mode: 'replay', cassette: join(dir, 'none.json') }),
    );

    const response = await chat(player.url, question('m', 'Et nytt spørsmål'));

    expect(response.status).toBe(404);
    expect(await response.text()).toMatch(/playback_miss/);
    expect(player.misses).toHaveLength(1);
  });

  it('hashes the conversation, not the model or sampling details', () => {
    const base = { messages: [{ role: 'user', content: 'x' }] };
    expect(requestHash('/v1/chat/completions', { ...base, model: 'a', temperature: 0 })).toBe(
      requestHash('/openai/deployments/d/chat/completions?api-version=1', {
        ...base,
        model: 'b',
        user: 'u',
      }),
    );
    expect(requestHash('/v1/chat/completions', base)).not.toBe(
      requestHash('/v1/chat/completions', { messages: [{ role: 'user', content: 'y' }] }),
    );
  });
});
