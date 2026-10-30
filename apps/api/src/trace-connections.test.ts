import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { tracesContent } from './boot-guard.js';
import { createPlatform } from './composition.js';
import { pinnedFetch, type TracingOptions } from './trace-connections.js';

const tenant = '991825827';
const other = '889640782';
const instance = 'https://langfuse.digdir.example.no';
const own = 'https://langfuse.etaten.example.no';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant,
    authorizedFor: [{ org: tenant }],
  },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant,
    authorizedFor: [{ org: tenant, actions: ['use-services'] }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: other,
    authorizedFor: [{ org: other }],
  },
  operator: { kind: 'operator', issuer: 'test', subject: 'digdir-drift' },
  driftsmedlem: {
    kind: 'operator',
    issuer: 'test',
    subject: 'digdir-drift-medlem',
    authorizedFor: [{ org: tenant, actions: ['read'] }],
  },
};

const addresses: Record<string, string> = {
  'langfuse.digdir.example.no': '93.184.216.34',
  'langfuse.etaten.example.no': '93.184.216.35',
  'privat.example.no': '10.0.0.5',
  'metadata.example.no': '169.254.169.254',
};

const boot = async (tracing: TracingOptions = { instance }) => {
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const who = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      return people[who] ? { principal: people[who] } : undefined;
    },
    egress: {
      lookup: async (host) => (addresses[host] ? [addresses[host]] : ['127.0.0.1']),
      timeoutMs: 5000,
    },
    tracing,
  });
  const app = new Hono();
  platform.mount(
    app,
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      extensions: platform.extensions,
    }),
  );
  const send = async (method: string, path: string, who = 'kari', body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        'change-reason': 'Kobler tjenesten til Langfuse',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: res.status,
      task: res.headers.get('genai-task'),
      body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };
  const secret = (name: string, host: string, owner = tenant, who = 'kari') =>
    send('PUT', `/tenants/${owner}/secrets/${name}`, who, {
      value: 'sk-lf-hemmelig',
      allowedHosts: [host],
    });
  const connect = (id: string, connection: Record<string, unknown>, who = 'kari') =>
    send('PUT', `/tenants/${tenant}/tracing/connections/${id}`, who, connection);
  return { platform, send, secret, connect };
};

const ownConnection = (patch: Record<string, unknown> = {}) => ({
  host: own,
  publicKey: 'pk-lf-etaten',
  secretKey: `secret://tenant/${tenant}/langfuse-etaten`,
  services: ['svar'],
  residency: 'norway',
  ...patch,
});

const errorsOf = (body: Record<string, unknown>) =>
  (body.errors as { path: string; message: string }[]).map((e) => `${e.path}: ${e.message}`);

describe("an agency's Langfuse connections", () => {
  it('saves a connection with a secret reference and lists it without the secret', async () => {
    const env = await boot();
    await env.secret('langfuse-etaten', own);

    const saved = await env.connect('etaten', ownConnection());
    const listed = await env.send('GET', `/tenants/${tenant}/tracing/connections`);
    const elsewhere = await env.send('GET', `/tenants/${tenant}/tracing/connections`, 'ola');

    expect(saved.status).toBe(200);
    expect(listed.body.data).toEqual([
      {
        id: 'etaten',
        host: own,
        publicKey: 'pk-lf-etaten',
        secretKey: `secret://tenant/${tenant}/langfuse-etaten`,
        services: ['svar'],
        residency: 'norway',
        content: false,
        erasureDeclared: false,
        instance: false,
        residencySetBy: 'tenant',
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain('sk-lf-hemmelig');
    expect(elsewhere.status).toBe(404);
  });

  it('refuses a host that is not HTTPS, or resolves to a private or link-local address', async () => {
    const env = await boot();
    for (const host of [
      'http://langfuse.etaten.example.no',
      'https://privat.example.no',
      'https://metadata.example.no',
    ])
      await env.secret(`s-${new URL(host).hostname.split('.')[0]}`, host);

    const http = await env.connect(
      'a',
      ownConnection({
        host: 'http://langfuse.etaten.example.no',
        secretKey: `secret://tenant/${tenant}/s-langfuse`,
      }),
    );
    const privat = await env.connect(
      'b',
      ownConnection({
        host: 'https://privat.example.no',
        secretKey: `secret://tenant/${tenant}/s-privat`,
        services: [],
      }),
    );
    const linkLocal = await env.connect(
      'c',
      ownConnection({
        host: 'https://metadata.example.no',
        secretKey: `secret://tenant/${tenant}/s-metadata`,
        services: [],
      }),
    );

    expect(errorsOf(http.body)).toContain('connection.host: the host must use HTTPS');
    expect(errorsOf(privat.body)).toEqual([
      'connection.host: privat.example.no resolves to a private address',
    ]);
    expect(errorsOf(linkLocal.body)[0]).toMatch(
      /^connection\.host: metadata\.example\.no resolves to a/,
    );
  });

  it("refuses another tenant's secret, a secret not set for the host, and a key typed in clear", async () => {
    const env = await boot();
    await env.secret('langfuse-annet', own, other, 'ola');
    await env.secret('langfuse-feil-vert', 'https://annen.example.no');

    const foreign = await env.connect(
      'a',
      ownConnection({ secretKey: `secret://tenant/${other}/langfuse-annet` }),
    );
    const wrongHost = await env.connect(
      'b',
      ownConnection({ secretKey: `secret://tenant/${tenant}/langfuse-feil-vert` }),
    );
    const clear = await env.connect('c', ownConnection({ secretKey: 'sk-lf-hemmelig' }));

    expect(errorsOf(foreign.body)).toEqual([
      'connection.secretKey: the secret belongs to another tenant',
    ]);
    expect(errorsOf(wrongHost.body)).toEqual([
      `connection.secretKey: the secret is not set for ${own}`,
    ]);
    expect(errorsOf(clear.body)).toEqual([
      'connection.secretKey: must be a secret://tenant/<tenant>/<name> reference',
    ]);
    // Refused before an admin task starts, so the typed key never reaches a task's input.
    expect(clear.task).toBeNull();
    expect(foreign.task).not.toBeNull();
  });

  it('covers a service with at most one connection', async () => {
    const env = await boot();
    await env.secret('langfuse-etaten', own);
    await env.connect('etaten', ownConnection());

    const second = await env.connect('andre', ownConnection());

    expect(errorsOf(second.body)).toEqual([
      'connection.services: svar is already covered by the connection etaten',
    ]);
  });

  it("starts a connection to Digdir's Langfuse as global, and only an operator sets its residency", async () => {
    const env = await boot();
    await env.secret('langfuse-digdir', instance);
    const connection = {
      host: instance,
      publicKey: 'pk-lf-digdir',
      secretKey: `secret://tenant/${tenant}/langfuse-digdir`,
      services: ['svar'],
    };

    const saved = await env.connect('digdir', connection);
    const tenantSays = await env.connect('digdir', { ...connection, residency: 'norway' });
    const byTenant = await env.send(
      'PUT',
      `/operator/tracing/connections/${tenant}/digdir/residency`,
      'kari',
      {
        residency: 'eu',
      },
    );
    const byOperator = await env.send(
      'PUT',
      `/operator/tracing/connections/${tenant}/digdir/residency`,
      'operator',
      { residency: 'eu' },
    );
    const listed = await env.send('GET', `/tenants/${tenant}/tracing/connections`);

    expect(saved.body).toMatchObject({ residency: 'global' });
    expect(errorsOf(tenantSays.body)).toEqual([
      "connection.residency: an operator sets the residency of a connection to Digdir's Langfuse",
    ]);
    expect(byTenant.status).toBe(403);
    expect(byOperator.body).toMatchObject({ residency: 'eu' });
    expect(listed.body.data).toEqual([
      expect.objectContaining({ residency: 'eu', instance: true, residencySetBy: 'operator' }),
    ]);
  });

  it("receives content only where erasure holds: Digdir's Langfuse once operators confirm it, an agency's own once it declares it", async () => {
    const closed = await boot({ instance });
    const open = await boot({ instance, instanceReceivesContent: true });
    for (const env of [closed, open]) {
      await env.secret('langfuse-digdir', instance);
      await env.secret('langfuse-etaten', own);
    }
    const onInstance = {
      host: instance,
      publicKey: 'pk-lf-digdir',
      secretKey: `secret://tenant/${tenant}/langfuse-digdir`,
      content: true,
    };

    const instanceClosed = await closed.connect('digdir', onInstance);
    const instanceOpen = await open.connect('digdir', onInstance);
    const undeclared = await closed.connect('etaten', ownConnection({ content: true }));
    const declared = await closed.connect(
      'etaten',
      ownConnection({ content: true, erasureDeclared: true }),
    );

    expect(errorsOf(instanceClosed.body)[0]).toMatch(
      /^connection\.content: Digdir's Langfuse does not receive content/,
    );
    expect(instanceOpen.body).toMatchObject({ content: true });
    expect(errorsOf(undeclared.body)[0]).toMatch(
      /^connection\.content: content needs the declaration/,
    );
    expect(declared.body).toMatchObject({ content: true, erasureDeclared: true });
  });

  it('lets only a person with manage-services change connections, also an operator who is a member', async () => {
    const env = await boot();
    await env.secret('langfuse-etaten', own);

    const refused = await env.connect('etaten', ownConnection(), 'erik');
    const removed = await env.send(
      'DELETE',
      `/tenants/${tenant}/tracing/connections/etaten`,
      'erik',
    );
    const operator = await env.connect('etaten', ownConnection(), 'driftsmedlem');

    expect(refused.status).toBe(403);
    expect(removed.status).toBe(403);
    expect(operator.status).toBe(403);
  });
});

describe('configuration from the environment', () => {
  it('honours TRACES_CONTENT only in development mode', () => {
    expect(tracesContent({ TRACES_CONTENT: 'true' })).toBe(false);
    expect(tracesContent({ TRACES_CONTENT: 'true', GENAI_DEV_MODE: 'true' })).toBe(true);
    expect(tracesContent({ GENAI_DEV_MODE: 'true' })).toBe(false);
  });
});

const localLangfuse = process.env.LANGFUSE_LOCAL_URL;

describe.skipIf(!localLangfuse)('a local Langfuse 4.4.0 in development mode', () => {
  it('checks a connection against its project through the egress path', async () => {
    const host = localLangfuse as string;
    const env = await boot({ devMode: true });
    await env.send('PUT', `/tenants/${tenant}/secrets/langfuse-lokal`, 'kari', {
      value: process.env.LANGFUSE_LOCAL_SECRET_KEY ?? 'sk-lf-genki-test',
      allowedHosts: [host],
    });
    await env.connect('lokal', {
      host,
      publicKey: process.env.LANGFUSE_LOCAL_PUBLIC_KEY ?? 'pk-lf-genki-test',
      secretKey: `secret://tenant/${tenant}/langfuse-lokal`,
      services: ['svar'],
      content: true,
    });

    const checked = await env.send('POST', `/tenants/${tenant}/tracing/connections/lokal/check`);

    expect(checked.body).toMatchObject({ ok: true, project: { id: expect.any(String) } });
  });
});

describe("an exporter's requests to a connection", () => {
  it("go through the guard's pinned request, with the method, headers, body and signal", async () => {
    const seen: unknown[][] = [];
    const guard = {
      request: async (...args: unknown[]) => {
        seen.push(args);
        return { status: seen.length === 1 ? 200 : 204, headers: {}, body: '{}' };
      },
    };
    const allow = [{ host: 'langfuse.etaten.example.no', protocol: 'https' as const }];
    const send = pinnedFetch(guard as never, allow as never);
    const signal = new AbortController().signal;

    const sent = await send('https://langfuse.etaten.example.no/api/public/otel/v1/traces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"resourceSpans":[]}',
      signal,
    });
    const empty = await send('https://langfuse.etaten.example.no/api/public/health');

    expect(seen[0]).toEqual([
      allow,
      'https://langfuse.etaten.example.no/api/public/otel/v1/traces',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"resourceSpans":[]}',
      },
      signal,
    ]);
    expect(sent.status).toBe(200);
    expect(await sent.text()).toBe('{}');
    expect(empty.status).toBe(204);
  });
});
