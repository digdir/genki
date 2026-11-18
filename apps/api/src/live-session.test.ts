import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import {
  acceptWebSocket,
  descriptorRegistry,
  loadDescriptors,
  parseDescriptor,
} from '@genai/operations';
import { syntheticNationalId } from '@genai/kernel/gate-contract';
import { bootPlatform, digdir } from './testkit.js';
import { attachSessionUpgrade } from './session-upgrade.js';

const sessionYaml = readFileSync(
  join(
    import.meta.dirname,
    '../../../packages/operations/src/testdata/descriptors/example/chat-session@1.yaml',
  ),
  'utf8',
);

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  saksbehandling: {
    kind: 'agency-system',
    issuer: 'test',
    subject: 'saksbehandling',
    tenant: digdir,
    scopes: ['legacy:query'],
  },
};

const servers: Server[] = [];
const sockets: Duplex[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
};

const reason = 'Tjenesten er en direkte økt';

const boot = async () => {
  const received: string[] = [];
  const provider = createServer();
  provider.on('upgrade', (req, socket, head) => {
    sockets.push(socket);
    const peer = acceptWebSocket(req, socket, head);
    if (!peer) return;
    void (async () => {
      for await (const message of peer.messages()) {
        if (message.kind !== 'text') continue;
        received.push(message.text);
        const event = JSON.parse(message.text) as { event: string; text?: string };
        if (event.event === 'say') {
          peer.send({
            kind: 'text',
            text: JSON.stringify({ event: 'reply', text: `du sa: ${event.text}` }),
          });
          peer.send({
            kind: 'text',
            text: JSON.stringify({ event: 'stats', input: 3, output: 4 }),
          });
          peer.send({ kind: 'text', text: JSON.stringify({ event: 'bye' }) });
        }
      }
    })();
  });
  const providerPort = await listen(provider);
  const booted = await bootPlatform({
    people,
    descriptors: descriptorRegistry([...loadDescriptors().list(), parseDescriptor(sessionYaml)]),
    models: {
      endpoints: {
        lab: {
          families: { example: '' },
          baseURL: `http://127.0.0.1:${providerPort}/v1`,
          auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
        },
      },
      models: [
        {
          id: 'lab/small',
          endpoint: 'lab',
          deployment: 'small',
          residency: 'norway',
          capabilities: ['json-schema'],
          operations: ['chat', 'chat-session'],
        },
      ],
    },
  });
  expect(
    (
      await booted.send('/operator/operation-kinds/chat-session/maturity', 'drift', {
        body: { maturity: 'production' },
        reason,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await booted.send('/operator/model-endpoints/lab/processor-record', 'drift', {
        method: 'PUT',
        reason,
        body: {
          agreement: 'DPA-2026-17, signed 2026-09-01',
          subProcessors: [{ name: 'Lab Cloud AS', location: 'Norway' }],
          retention: { days: 0, note: 'No abuse monitoring' },
        },
      })
    ).status,
  ).toBe(200);
  const published = await booted.platform.definitions.publish(
    {
      apiVersion: 'genai/v1',
      kind: 'Service',
      metadata: { tenant: digdir, id: 'direkte', name: 'Direkte' },
      spec: {
        purpose: 'Samtale i sanntid med en leverandør',
        audience: ['employees'],
        riskClass: 'minimal',
        input: { accepts: ['text/plain'] },
        output: { kind: 'answer' },
        strategy: {
          id: 'live-session',
          version: 1,
          config: { descriptor: 'example/chat-session@1' },
        },
        model: { primary: 'lab/small', residency: 'norway' },
        guardrails: { 'pii-before-model': { categories: ['national-id'], restore: true } },
        exposure: { rest: true, openai: true },
      },
    },
    'test',
    'test',
  );
  expect(published.ok ? [] : published.errors).toEqual([]);
  const edge = createServer();
  attachSessionUpgrade(edge, booted.app, booted.platform.liveSessions);
  const edgePort = await listen(edge);
  return { ...booted, received, edge: `ws://127.0.0.1:${edgePort}` };
};

const open = (url: string, token?: string) =>
  new Promise<{ socket: WebSocket; messages: string[]; closed: Promise<number> }>(
    (resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      } as never);
      const messages: string[] = [];
      const closed = new Promise<number>((done) =>
        socket.addEventListener('close', (e) => done(e.code)),
      );
      socket.addEventListener('message', (e) => messages.push(String(e.data)));
      socket.addEventListener('open', () => resolve({ socket, messages, closed }));
      socket.addEventListener('error', () => reject(new Error('refused')));
    },
  );

describe('GET /v1/sessions (E)', () => {
  it('a live session needs the same login as the chat route', async () => {
    const booted = await boot();
    await expect(open(`${booted.edge}/v1/sessions?model=direkte__default`)).rejects.toThrow(
      'refused',
    );
  });

  it('a plain request to /v1/sessions is told to upgrade', async () => {
    const booted = await boot();
    const response = await booted.send('/v1/sessions?model=direkte__default', 'saksbehandling');
    expect(response.status).toBe(426);
  });

  it('the chat route does not serve a live service', async () => {
    const booted = await boot();
    const response = await booted.send('/v1/chat/completions', 'saksbehandling', {
      body: { model: 'direkte__default', messages: [{ role: 'user', content: 'hei' }] },
    });
    expect(response.status).toBe(400);
  });

  it('a session relays both ways, masks a national id towards the provider and restores it back', async () => {
    const booted = await boot();
    const { socket, messages, closed } = await open(
      `${booted.edge}/v1/sessions?model=direkte__default&topic=hei`,
      'saksbehandling',
    );
    socket.send(
      JSON.stringify({ event: 'say', text: `Mitt fødselsnummer er ${syntheticNationalId}` }),
    );
    expect(await closed).toBe(1000);
    expect(booted.received.join('\n')).not.toContain(syntheticNationalId);
    expect(messages.join('\n')).toContain(syntheticNationalId);
  });
});
