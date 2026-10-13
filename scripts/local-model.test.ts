import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localCompletion, startLocalModel } from './local-model.ts';

let server: Server;
let base: string;

beforeAll(async () => {
  server = await startLocalModel(0);
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
});
