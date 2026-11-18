import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@genai/contracts';
import { platformModules } from './composition.js';
import { maxPlatformSecretLength } from './platform-secrets.js';
import { bootPlatform, digdir, readJson as json } from './testkit.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const reason = 'Ny nøkkel fra leverandøren';
const fakeValue = 'fake-value-7f3a9c';

const connection = {
  id: 'sigma2',
  families: { openai: '' },
  baseURL: 'https://llm.sigma2.test/v1',
  auth: { kind: 'bearer', secret: 'secret://platform/sigma2-key' },
};

interface Listed {
  data: {
    name: string;
    ref: string;
    set: boolean;
    changedAt?: string;
    usedBy: { kind: string; id: string }[];
  }[];
}

const boot = () => bootPlatform({ people, modules: platformModules });

const put = (
  send: Awaited<ReturnType<typeof boot>>['send'],
  who: string,
  name: string,
  value: unknown,
  withReason: string | null = reason,
) =>
  send(`/operator/secrets/${name}`, who, {
    method: 'PUT',
    body: { value },
    ...(withReason ? { reason: withReason } : {}),
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('platform secrets for operators', () => {
  it('refuses a non-operator who lists platform secrets with 403', async () => {
    const { send } = await boot();

    expect((await send('/operator/secrets', 'kari')).status).toBe(403);
  });

  it('refuses a non-operator who sets a platform secret with 403 and stores nothing', async () => {
    const { send } = await boot();

    const refused = await put(send, 'kari', 'sigma2-key', fakeValue);
    const listed = await json<Listed>(await send('/operator/secrets', 'drift'));

    expect(refused.status).toBe(403);
    expect(listed.data.find((s) => s.name === 'sigma2-key')).toBeUndefined();
  });

  it('refuses an anonymous caller with 401', async () => {
    const { app } = await boot();

    expect((await app.request('/operator/secrets')).status).toBe(401);
  });

  it('refuses a change without a reason and stores nothing', async () => {
    const { send } = await boot();

    const refused = await put(send, 'drift', 'sigma2-key', fakeValue, null);
    const listed = await json<Listed>(await send('/operator/secrets', 'drift'));

    expect(refused.status).toBe(400);
    expect(listed.data.find((s) => s.name === 'sigma2-key')).toBeUndefined();
  });

  it('never returns the value, only whether it is set and when it last changed', async () => {
    const { send } = await boot();

    const saved = await put(send, 'drift', 'sigma2-key', fakeValue);
    const listed = await send('/operator/secrets', 'drift');
    const text = await listed.text();

    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain(fakeValue);
    expect(text).not.toContain(fakeValue);
    expect((JSON.parse(text) as Listed).data).toEqual([
      {
        name: 'sigma2-key',
        ref: 'secret://platform/sigma2-key',
        set: true,
        changedAt: expect.any(String),
        usedBy: [],
      },
    ]);
  });

  it('never writes the value to the console, the task, its events or the audit log', async () => {
    const { send, admin } = await boot();
    const written: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    for (const stream of [process.stdout, process.stderr])
      vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });

    const saved = await put(send, 'drift', 'sigma2-key', fakeValue);
    vi.restoreAllMocks();
    const task = saved.headers.get('genai-task') ?? '';
    const events = await admin.events(task);

    expect(written.join('\n')).not.toContain(fakeValue);
    expect(saved.status).toBe(200);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(fakeValue);
    expect(JSON.stringify(await admin.task(task))).not.toContain(fakeValue);
    expect(JSON.stringify(await admin.audit())).not.toContain(fakeValue);
  });

  it('audits a change with the name, who, when and the reason, and no value', async () => {
    const { send, admin } = await boot();

    await put(send, 'drift', 'sigma2-key', fakeValue);
    const entries = (await admin.audit()).filter(
      (e) => e.action === 'platform.platform-secret.set',
    );

    expect(entries).toEqual([
      expect.objectContaining({
        actor: expect.stringContaining('drift'),
        at: expect.any(String),
        outcome: 'applied',
        target: 'secret:platform/sigma2-key',
        reason,
      }),
    ]);
    expect(JSON.stringify(entries)).not.toContain(fakeValue);
  });

  it('lists a secret a connection names but nobody has stored as not set, with the connection that uses it', async () => {
    const { send } = await boot();

    expect(
      (await send('/operator/model-endpoints', 'drift', { body: connection, reason })).status,
    ).toBe(201);
    const listed = await json<Listed>(await send('/operator/secrets', 'drift'));

    expect(listed.data).toEqual([
      {
        name: 'sigma2-key',
        ref: 'secret://platform/sigma2-key',
        set: false,
        usedBy: [{ kind: 'model-endpoint', id: 'sigma2' }],
      },
    ]);
  });

  it('refuses a value longer than the limit and stores nothing', async () => {
    const { send } = await boot();

    const refused = await put(send, 'drift', 'sigma2-key', 'x'.repeat(maxPlatformSecretLength + 1));
    const listed = await json<Listed>(await send('/operator/secrets', 'drift'));

    expect(refused.status).toBe(400);
    expect(listed.data).toEqual([]);
  });

  it('refuses a request body over the size limit before reading it', async () => {
    const { send } = await boot();

    const refused = await put(send, 'drift', 'sigma2-key', 'x'.repeat(maxPlatformSecretLength * 5));

    expect(refused.status).toBe(413);
  });

  it('refuses an empty value and a name that is not a secret name', async () => {
    const { send } = await boot();

    expect((await put(send, 'drift', 'sigma2-key', '   ')).status).toBe(400);
    expect((await put(send, 'drift', 'Sigma2%20Key', fakeValue)).status).toBe(400);
    expect((await put(send, 'drift', 'a'.repeat(64), fakeValue)).status).toBe(400);
  });
});
