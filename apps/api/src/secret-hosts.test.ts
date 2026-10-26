import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, readJson } from './testkit.js';

const person = (subject: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant: digdir,
  authorizedFor: [{ org: digdir, actions }],
});

const people = {
  bygger: person('bygger', ['use-services', 'register-building-blocks']),
  admin: person('admin', ['use-services', 'manage-services']),
};

const secret = `/tenants/${digdir}/secrets/arkiv-nokkel`;

const boot = async () => {
  const { send, platform } = await bootPlatform({ people });
  const put = (path: string, as: string, body: unknown) =>
    send(path, as, { method: 'PUT', body, reason: 'Nøkkel til arkivet' });
  const listed = async () =>
    (
      await readJson<{ data: { name: string; allowedHosts: string[] }[] }>(
        await send(`/tenants/${digdir}/building-blocks/secrets`, 'bygger'),
      )
    ).data;
  return { send, put, listed, platform };
};

describe('tenant secret hosts', () => {
  it('a new secret needs the hosts it is for', async () => {
    const { put, listed } = await boot();

    const missing = await put(secret, 'bygger', { value: 'hemmelig-verdi' });
    const invalid = await put(secret, 'bygger', {
      value: 'hemmelig-verdi',
      allowedHosts: ['https://arkiv.example.no/sti'],
    });
    const stored = await put(secret, 'bygger', {
      value: 'hemmelig-verdi',
      allowedHosts: ['arkiv.example.no', 'https://token.example.no:8443'],
    });

    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ errors: [{ path: 'allowedHosts' }] });
    expect(invalid.status).toBe(400);
    expect(stored.status).toBe(200);
    expect(await listed()).toEqual([
      expect.objectContaining({
        name: 'arkiv-nokkel',
        allowedHosts: ['https://arkiv.example.no', 'https://token.example.no:8443'],
      }),
    ]);
  });

  it("changing a secret's hosts needs manage-services", async () => {
    const { put, listed, platform } = await boot();
    await put(secret, 'admin', {
      value: 'hemmelig-verdi',
      allowedHosts: ['https://arkiv.example.no'],
    });

    const throughHosts = await put(`${secret}/hosts`, 'bygger', {
      allowedHosts: ['https://annen.example.com'],
    });
    const throughValue = await put(secret, 'bygger', {
      value: 'ny-verdi',
      allowedHosts: ['https://annen.example.com'],
    });
    const valueOnly = await put(secret, 'bygger', { value: 'ny-verdi' });
    const hostsAfterBuilder = (await listed())[0]?.allowedHosts;
    const byAdmin = await put(`${secret}/hosts`, 'admin', {
      allowedHosts: ['https://arkiv.example.no', 'https://ny.example.no'],
    });

    expect(throughHosts.status).toBe(403);
    expect(throughValue.status).toBe(403);
    expect(valueOnly.status).toBe(200);
    expect(hostsAfterBuilder).toEqual(['https://arkiv.example.no']);
    expect(byAdmin.status).toBe(200);
    expect(await listed()).toEqual([
      expect.objectContaining({
        allowedHosts: ['https://arkiv.example.no', 'https://ny.example.no'],
      }),
    ]);
    expect(await platform.vault.hosts(digdir, 'arkiv-nokkel')).toEqual([
      'https://arkiv.example.no',
      'https://ny.example.no',
    ]);
  });

  it('setting the hosts of a secret that does not exist answers 404', async () => {
    const { put } = await boot();

    const res = await put(`${secret}/hosts`, 'admin', {
      allowedHosts: ['https://arkiv.example.no'],
    });

    expect(res.status).toBe(404);
  });

  it('registering a tool connection through the API refuses a secret bound to another host, also for a service admin', async () => {
    const { send, put } = await boot();
    await put(secret, 'admin', {
      value: 'hemmelig-verdi',
      allowedHosts: ['https://arkiv.example.no'],
    });

    const res = await send(`/tenants/${digdir}/tool-connections`, 'admin', {
      body: {
        id: 'annen',
        name: 'Annen tjener',
        endpoint: 'https://annen.example.com/mcp',
        version: '1',
        allow: [{ host: 'annen.example.com' }],
        auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/arkiv-nokkel` },
      },
      reason: 'Ny MCP-tjener',
    });
    const listed = await readJson<{ data: unknown[] }>(
      await send(`/tenants/${digdir}/tool-connections`, 'bygger'),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      errors: [
        {
          path: 'connection.auth.secret',
          message: expect.stringContaining('er ikke satt opp for https://annen.example.com'),
        },
      ],
    });
    expect(listed.data).toEqual([]);
  });
});
