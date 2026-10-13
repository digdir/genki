import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal, Task } from '@genai/contracts';
import { InMemoryFeedbackStore } from '@genai/eval';
import { checkClient, InMemoryClients } from '@genai/identity';
import { InMemoryEventLog, InMemoryTaskStore, type TaskStore } from '@genai/kernel';
import {
  createWebhooks,
  egressSender,
  SIGNATURE_HEADER,
  signWebhook,
  verifyWebhookSignature,
  webhookSecretRef,
} from './webhooks.js';

const tenant = '991825827';
const secret = 'whsec-test-value';

const client = (id: string, events: string[], service = 'kunnskapsassistenten') => {
  const checked = checkClient(
    {
      apiVersion: 'genai/v1',
      kind: 'Client',
      metadata: { tenant, id },
      spec: {
        service,
        kind: 'server',
        channels: ['mcp'],
        webhook: { url: `https://hooks.example.no/${id}`, events, secret: 'ka-webhook' },
      },
    },
    [],
  );
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return { definition: checked.definition, version: 1, updatedAt: '', updatedBy: 'test' };
};

const task = (id: string): Task => ({
  id,
  service: {
    capability: { id: `${tenant}/kunnskapsassistenten/default`, version: '1' },
    strategy: { id: 'agent-loop', version: '1' },
    configHash: 'h',
  },
  principal: { kind: 'agency-system', id: 'k1' },
  tenant,
  owner: tenant,
  status: 'completed',
  artifacts: [],
  usage: {},
  createdAt: '2026-10-07T10:00:00Z',
});

const setup = async () => {
  const clients = new InMemoryClients();
  await clients.save(client('ka-web', ['task.completed', 'feedback.received']));
  await clients.save(client('quiet', ['feedback.received']));
  await clients.save(client('elsewhere', ['task.completed'], 'nynorsk'));
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const tasks: TaskStore = new InMemoryTaskStore();
  const principal: Principal = { kind: 'agency-system', issuer: 'test', subject: 'k1', tenant };
  await tasks.put({ task: task('t1'), principal, lastSeq: 0 }, { tenant, key: 't1' });
  const webhooks = createWebhooks({
    clients,
    secrets: {
      resolve: async (ref) => {
        if (ref === webhookSecretRef(tenant, 'ka-webhook')) return secret;
        throw new Error('unknown secret');
      },
    },
    now: () => new Date('2026-10-07T10:00:00Z'),
    send: async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return { status: 204 };
    },
  });
  return { webhooks, sent, tasks };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('webhook signatures', () => {
  it('verifies its own signature and rejects tampering, other secrets and old timestamps', () => {
    const body = '{"event":"ping"}';
    const now = new Date('2026-10-07T10:00:00Z');
    const header = signWebhook(secret, now.getTime() / 1000, body);
    expect(verifyWebhookSignature(secret, header, body, now)).toBe(true);
    expect(verifyWebhookSignature(secret, header, '{"event":"pong"}', now)).toBe(false);
    expect(verifyWebhookSignature('other', header, body, now)).toBe(false);
    expect(
      verifyWebhookSignature(secret, header, body, new Date(now.getTime() + 10 * 60_000)),
    ).toBe(false);
  });
});

describe('client webhooks', () => {
  it('sends a signed task.completed event to the clients of the service that subscribe', async () => {
    const { webhooks, sent, tasks } = await setup();
    const log = webhooks.observe(new InMemoryEventLog(), tasks);
    await log.append(
      {
        type: 'kernel.task.status',
        task: 't1',
        ts: '2026-10-07T10:00:00Z',
        audience: 'client',
        actor: 'kernel',
        data: { status: 'completed' },
      } as never,
      { tenant, key: 't1' },
    );
    await settle();
    expect(sent.map((s) => s.url)).toEqual(['https://hooks.example.no/ka-web']);
    const [delivery] = sent;
    expect(delivery?.headers['genai-event']).toBe('task.completed');
    expect(
      verifyWebhookSignature(
        secret,
        delivery?.headers[SIGNATURE_HEADER] ?? '',
        delivery?.body ?? '',
        new Date('2026-10-07T10:00:00Z'),
      ),
    ).toBe(true);
    expect(JSON.parse(delivery?.body ?? '{}')).toMatchObject({
      event: 'task.completed',
      client: 'ka-web',
      data: { task: 't1', service: 'kunnskapsassistenten' },
    });
  });

  it('sends feedback.received without the comment, and keeps the delivery', async () => {
    const { webhooks, sent, tasks } = await setup();
    const store = webhooks.feedback(new InMemoryFeedbackStore(), tasks);
    await store.save({
      task: 't1',
      rating: 'down',
      comment: 'Personlig kommentar',
      tenant,
    } as never);
    await settle();
    expect(sent.map((s) => s.url).sort()).toEqual([
      'https://hooks.example.no/ka-web',
      'https://hooks.example.no/quiet',
    ]);
    expect(sent[0]?.body).not.toContain('Personlig');
    expect(await webhooks.deliveries(tenant, 'ka-web')).toMatchObject([
      { event: 'feedback.received', ok: true, status: 204 },
    ]);
  });

  it('records a failed delivery when the secret is missing', async () => {
    const { webhooks } = await setup();
    const broken = client('ka-web', ['task.completed']);
    broken.definition.spec.webhook = {
      url: 'https://hooks.example.no/ka-web',
      events: ['task.completed'],
      secret: 'missing',
    };
    expect(await webhooks.deliver(broken, 'ping', {})).toMatchObject({
      ok: false,
      error: 'the secret missing is not set',
    });
  });
});

describe('webhook egress', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  const receiver = async () => {
    const received: { headers: Record<string, unknown>; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, received };
  };

  const send = (sender: ReturnType<typeof egressSender>, url: string) =>
    sender(url, { headers: { 'content-type': 'application/json' }, body: '{}' });

  it('refuses loopback and plain http unless the platform runs locally', async () => {
    const { url, received } = await receiver();
    await expect(send(egressSender(), url)).rejects.toMatchObject({ code: 'insecure' });
    await expect(
      send(egressSender({ testOverride: { allowHttp: true } }), url),
    ).rejects.toMatchObject({ code: 'private_address' });
    expect(received).toEqual([]);

    const local = egressSender({ testOverride: { allowHttp: true, allowLoopback: true } });
    expect(await send(local, url)).toMatchObject({ status: 204 });
    expect(received).toHaveLength(1);
  });

  it('refuses hosts that resolve to private or link-local addresses', async () => {
    for (const address of ['10.0.0.5', '169.254.169.254', '192.168.1.1']) {
      const sender = egressSender({ lookup: async () => [address] });
      await expect(send(sender, 'https://hooks.example.no/ka')).rejects.toMatchObject({
        code: 'private_address',
      });
    }
  });

  it('refuses platform hosts and records the refusal as a failed delivery', async () => {
    const clients = new InMemoryClients();
    const webhooks = createWebhooks({
      clients,
      secrets: { resolve: async () => secret },
      send: egressSender({
        platformHosts: ['hooks.example.no'],
        lookup: async () => ['203.0.113.7'],
      }),
    });
    const delivery = await webhooks.deliver(client('ka-web', ['task.completed']), 'ping', {});
    expect(delivery).toMatchObject({ ok: false, error: 'hooks.example.no is a platform host' });
    expect(await webhooks.deliveries(tenant, 'ka-web')).toHaveLength(1);
  });
});
