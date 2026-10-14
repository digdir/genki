import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import process from 'node:process';
import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { ApiError, createClient } from '@genai/client';

const platform = createClient({
  baseUrl: process.env.PLATFORM_URL ?? 'http://localhost:8080',
  apiKey: process.env.PLATFORM_KEY,
  userId: process.env.PLATFORM_USER ?? 'minimal-example',
});

const page = await readFile(new URL('./index.html', import.meta.url), 'utf8');

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const fail = (response, error) => {
  const status = error instanceof ApiError ? error.status : 500;
  if (!(error instanceof ApiError))
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  response.writeHead(status === 401 || status === 403 ? 502 : status, {
    'content-type': 'application/json',
  });
  response.end(
    JSON.stringify({ error: error instanceof ApiError ? error.message : 'Something went wrong' }),
  );
};

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(page);
    } else if (request.method === 'GET' && request.url === '/api/services') {
      const services = await platform.listServices();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(services.filter((s) => s.status !== 'paused')));
    } else if (request.method === 'POST' && request.url === '/api/ask') {
      const { service, question, conversationId } = await readJson(request);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      try {
        for await (const event of platform.stream({
          service,
          question,
          ...(conversationId ? { conversationId } : { newConversation: true }),
        }))
          response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      }
      response.end();
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    fail(response, error);
  }
});

const port = Number(process.env.PORT ?? 5190);
server.listen(port, () =>
  process.stdout.write(`Minimal frontend on http://localhost:${server.address().port}\n`),
);
