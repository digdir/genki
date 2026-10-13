import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..');

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

const fakePlatform = (options: { status?: number } = {}) => {
  const seen: Seen[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    seen.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    if (options.status) {
      response.writeHead(options.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'no access', code: 'unauthorized' } }));
    } else if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'enkel__default', title: 'Enkel' },
            { id: 'pause__default', title: 'Pause', status: 'paused' },
          ],
        }),
      );
    } else if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const frames = [
        { id: 'a1', conversation_id: 'conv-1', choices: [{ delta: { content: 'Svar ' } }] },
        { id: 'a1', choices: [{ delta: { content: 'med kilde [1]' } }] },
        {
          id: 'a1',
          sources: [
            {
              index: 1,
              title: 'Kilde',
              url: 'https://example.org/kilde',
              document_id: 'd1',
              excerpts: [{ chunk_id: 'c1', text: 'Utdrag' }],
            },
          ],
          citations: ['d1'],
        },
        { id: 'a1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(404).end();
    }
  });
  return { server, seen };
};

const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );

const children: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(() => resolve(undefined)))),
  );
});

const startExample = (platformUrl: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(
      join(repoRoot, 'node_modules', '.bin', 'tsx'),
      ['--conditions=source', join(import.meta.dirname, 'server.mjs')],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PORT: '0',
          PLATFORM_URL: platformUrl,
          PLATFORM_KEY: 'test-key',
          PLATFORM_USER: 'tester',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      const found = /http:\/\/localhost:(\d+)/.exec(output);
      if (found) resolve(`http://127.0.0.1:${found[1]}`);
    });
    child.stderr.on('data', (chunk: string) => (output += chunk));
    child.once('exit', (code) => reject(new Error(`example exited ${code}: ${output}`)));
  });

const events = (text: string) =>
  text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);

describe('examples/frontend-minimal', () => {
  it('serves the page, lists services that are not paused and streams an answer with sources', async () => {
    const platform = fakePlatform();
    servers.push(platform.server);
    const example = await startExample(await listen(platform.server));

    const page = await fetch(`${example}/`);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<form id="form">');

    const services = (await (await fetch(`${example}/api/services`)).json()) as { id: string }[];
    expect(services.map((s) => s.id)).toEqual(['enkel__default']);

    const first = events(
      await (
        await fetch(`${example}/api/ask`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ service: 'enkel__default', question: 'Hei' }),
        })
      ).text(),
    );
    expect(first.map((e) => e.type)).toEqual(['conversation', 'text', 'text', 'sources', 'done']);
    const done = first.at(-1) as { answer: { text: string; sources: { index: number }[] } };
    expect(done.answer.text).toBe('Svar med kilde [1]');
    expect(done.answer.sources.map((s) => s.index)).toEqual([1]);

    await (
      await fetch(`${example}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          service: 'enkel__default',
          question: 'Mer',
          conversationId: 'conv-1',
        }),
      })
    ).text();

    const asks = platform.seen.filter((s) => s.url === '/v1/chat/completions');
    expect(asks[0]?.body).toMatchObject({
      model: 'enkel__default',
      stream: true,
      genai_conversation: true,
    });
    expect(asks[1]?.body).toMatchObject({ conversation_id: 'conv-1' });
    expect(asks[1]?.body).not.toHaveProperty('genai_conversation');
    for (const call of platform.seen) {
      expect(call.headers['x-api-key']).toBe('test-key');
      expect(call.headers['x-user-id']).toBe('tester');
    }
  });

  it('keeps the key on the server and answers 502 when the platform refuses it', async () => {
    const platform = fakePlatform({ status: 401 });
    servers.push(platform.server);
    const example = await startExample(await listen(platform.server));

    const response = await fetch(`${example}/api/services`);

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('test-key');
  });
});
