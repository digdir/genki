import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { loadCatalog } from '@genai/composition/catalogs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localCompletion, responseFolders, startLocalModel } from './local-model.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  server = await startLocalModel(0, []);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ask = (body: Record<string, unknown>) =>
  fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'echo', ...body }),
  });

describe('local test model', () => {
  it('echoes the last user message without the structured input block', async () => {
    const response = await ask({
      messages: [
        { role: 'system', content: 'Svar kort.' },
        { role: 'user', content: 'Hei der\n\n{"query":"Hei der"}' },
      ],
    });
    const body = (await response.json()) as {
      choices: { message: { content: string } }[];
      usage: { total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe(
      'Lokal testmodell, ingen ekte KI. Du skrev: Hei der',
    );
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it('streams the same answer as server-sent events ending in [DONE]', async () => {
    const text = await (
      await ask({ stream: true, messages: [{ role: 'user', content: 'Strøm' }] })
    ).text();
    const events = text.split('\n\n').filter(Boolean);
    expect(events.at(-1)).toBe('data: [DONE]');
    const content = events
      .slice(0, -1)
      .map(
        (e) =>
          JSON.parse(e.slice('data: '.length)) as { choices: { delta?: { content?: string } }[] },
      )
      .map((e) => e.choices[0]?.delta?.content ?? '')
      .join('');
    expect(content).toBe('Lokal testmodell, ingen ekte KI. Du skrev: Strøm');
  });

  it('answers a JSON schema request with an object of that shape', () => {
    const reply = localCompletion({
      messages: [{ role: 'user', content: 'Tekst' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          schema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              changes: { type: 'array' },
              score: { type: 'number' },
            },
          },
        },
      },
    });
    expect(JSON.parse(reply)).toEqual({
      text: 'Lokal testmodell, ingen ekte KI. Du skrev: Tekst',
      changes: [],
      score: 0,
    });
  });

  it('every model it serves is in the local catalogue, and skipped without LOCAL_MODEL_URL', async () => {
    const configDir = join(import.meta.dirname, '../apps/api/config/local');
    const served = (await (await fetch(`${base}/models`)).json()) as { data: { id: string }[] };
    const local = (env: NodeJS.ProcessEnv) =>
      (
        loadCatalog(configDir, 'models.yaml', 'models', env).catalog.models as {
          id: string;
          endpoint: string;
          deployment: string;
        }[]
      ).filter((m) => m.endpoint === 'local-model');

    expect(local({ LOCAL_MODEL_URL: base }).map((m) => [m.id, m.deployment])).toEqual(
      served.data.map(({ id }) => [`local/${id}`, id]),
    );
    expect(served.data.map(({ id }) => id)).toEqual(['echo', 'replay']);
    expect(local({})).toEqual([]);
  });
});

describe('local test model response files', () => {
  let folder: string;
  let files: Server;
  let at: string;

  const file = (name: string, content: unknown) =>
    writeFileSync(join(folder, name), JSON.stringify(content));
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${at}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'local-model-'));
    files = await startLocalModel(0, [folder]);
    at = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => files.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  });

  it('replays a response file on its method and path, with or without a leading /v1', async () => {
    file('rank.json', {
      request: { method: 'PUT', path: '/rank' },
      response: { body: { ranked: [1] } },
    });
    for (const path of ['/rank', '/v1/rank', '/v1/rank/']) {
      expect(await (await call('PUT', path, { x: 1 })).json()).toEqual({ ranked: [1] });
    }
    expect((await call('POST', '/rank', {})).status).toBe(404);
  });

  it('reads a new response file on the next request, without a restart', async () => {
    expect((await call('POST', '/v1/new-api', {})).status).toBe(404);
    file('new-api.json', {
      request: { method: 'POST', path: '/v1/new-api' },
      response: { body: { ok: true } },
    });
    expect(await (await call('POST', '/v1/new-api', {})).json()).toEqual({ ok: true });
  });

  it('serves a descriptor fixture file unchanged', async () => {
    const fixture = readFileSync(
      join(
        import.meta.dirname,
        '../packages/operations/fixtures/openai/embeddings@1/one-text.json',
      ),
      'utf8',
    );
    writeFileSync(join(folder, 'embed.json'), fixture);
    const { response } = JSON.parse(fixture) as { response: { body: unknown } };
    const answer = await call('POST', '/v1/embeddings', {
      model: 'text-embedding-3-small',
      input: ['Another text'],
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual(response.body);
  });

  it('matches the request body as a subset and picks the file that matches the most keys', async () => {
    file('describe-a.json', {
      request: { method: 'POST', path: '/things/describe', body: { model: 'v' } },
      response: { body: 'any' },
    });
    file('describe-b.json', {
      request: {
        method: 'POST',
        path: '/things/describe',
        body: { model: 'v', style: { kind: 'short' } },
      },
      response: { body: 'short' },
    });
    file('describe-c.json', {
      request: { method: 'POST', path: '/things/describe', body: { model: 'w' } },
      response: { body: 'other' },
    });
    const ask = async (body: unknown) => (await call('POST', '/things/describe', body)).json();
    expect(await ask({ model: 'v', style: { kind: 'short', tone: 8 }, text: 'x' })).toBe('short');
    expect(await ask({ model: 'v', style: { kind: 'long' } })).toBe('any');
    expect(await ask({ model: 'w' })).toBe('other');
  });

  it('answers any input on the same method and path from a recorded fixture, whatever model it was recorded on', async () => {
    file('recorded.json', {
      request: {
        method: 'POST',
        path: '/v1/things/recorded',
        body: { model: 'real-deployment-2', thing: 'a lamp', detail: 'high' },
      },
      response: { body: { description: 'A lamp.' } },
    });
    const answer = await call('POST', '/things/recorded', {
      model: 'replay',
      thing: 'something else entirely',
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ description: 'A lamp.' });
  });

  it('among files on the same method and path, prefers the request model, then the most matching keys', async () => {
    file('loose-a.json', {
      request: { method: 'POST', path: '/loose', body: { model: 'l', input: 'a', size: 1 } },
      response: { body: 'a' },
    });
    file('loose-b.json', {
      request: { method: 'POST', path: '/loose', body: { model: 'l', input: 'b', size: 2 } },
      response: { body: 'b' },
    });
    file('loose-c.json', {
      request: { method: 'POST', path: '/loose', body: { model: 'm', input: 'c', size: 3 } },
      response: { body: 'c' },
    });
    const ask = async (body: unknown) => (await call('POST', '/loose', body)).json();
    expect(await ask({ model: 'l', input: 'b', size: 2 })).toBe('b');
    expect(await ask({ model: 'l', input: 'new', size: 2 })).toBe('b');
    expect(await ask({ model: 'l', input: 'new', size: 3 })).toBe('a');
    expect(await ask({ model: 'm', input: 'a', size: 1 })).toBe('c');
    expect(await ask({ model: 'replay', input: 'new', size: 3 })).toBe('c');
    expect(await ask({ model: 'replay', input: 'new' })).toBe('a');
  });

  it('breaks a tie between equally specific files by file name order', async () => {
    file('tie-2.json', {
      request: { method: 'POST', path: '/tie', body: { model: 't' } },
      response: { body: 'second' },
    });
    file('tie-1.json', {
      request: { method: 'POST', path: '/tie', body: { model: 't' } },
      response: { body: 'first' },
    });
    expect(await (await call('POST', '/tie', { model: 't' })).json()).toBe('first');
  });

  it('answers with the status and headers a response file gives', async () => {
    file('busy.json', {
      request: { method: 'POST', path: '/busy' },
      response: { status: 429, headers: { 'retry-after': '3' }, body: { error: 'busy' } },
    });
    const answer = await call('POST', '/busy', {});
    expect(answer.status).toBe(429);
    expect(answer.headers.get('retry-after')).toBe('3');
    expect(await answer.json()).toEqual({ error: 'busy' });
  });

  it('skips a file that is not a response file', async () => {
    writeFileSync(join(folder, 'broken.json'), '{ not json');
    file('half.json', { request: { method: 'POST', path: '/half' } });
    expect((await call('POST', '/half', {})).status).toBe(404);
  });

  it('falls back to the echo for a chat completion no response file matches', async () => {
    const answer = (await (
      await call('POST', '/v1/chat/completions', {
        model: 'echo',
        messages: [{ role: 'user', content: 'Hei' }],
      })
    ).json()) as { choices: { message: { content: string } }[] };
    expect(answer.choices[0]?.message.content).toBe(
      'Lokal testmodell, ingen ekte KI. Du skrev: Hei',
    );
  });

  it('answers 404 with a problem naming the method, path and folder when nothing matches', async () => {
    const answer = await call('POST', '/v1/unknown', {});
    expect(answer.status).toBe(404);
    expect(answer.headers.get('content-type')).toBe('application/problem+json');
    const problem = (await answer.json()) as { status: number; detail: string };
    expect(problem.status).toBe(404);
    expect(problem.detail).toContain('POST /v1/unknown');
    expect(problem.detail).toContain(folder);
  });

  it('lists echo and the deployments its response files name as models', async () => {
    const served = (await (await call('GET', '/v1/models')).json()) as { data: { id: string }[] };
    expect(served.data.map(({ id }) => id)).toEqual([
      'echo',
      'replay',
      'v',
      'w',
      'text-embedding-3-small',
      'l',
      'm',
      'real-deployment-2',
      't',
    ]);
  });

  it('reads response files only from the folders in LOCAL_MODEL_RESPONSES', () => {
    expect(responseFolders({ LOCAL_MODEL_RESPONSES: ['/a', '/b'].join(delimiter) })).toEqual([
      '/a',
      '/b',
    ]);
    expect(responseFolders({})).toEqual([]);
  });
});
