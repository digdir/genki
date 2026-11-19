import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@genai/contracts';
import { maxTenantSecretBytes, maxTenantSecrets } from '@genai/composition';
import { bootPlatform, digdir, other } from './testkit.js';

const person = (subject: string, tenant: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant,
  authorizedFor: [{ org: tenant, actions }],
});

const people = {
  admin: person('admin', digdir, ['use-services', 'manage-services']),
  ola: person('ola', other, ['use-services', 'manage-services']),
  leser: person('leser', digdir, ['use-services']),
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' } as Principal,
};

const hosts = ['https://login.ansattporten.example.no'];
const marker = 'verdi-som-aldri-skal-vises-3f9a';

const boot = async () => {
  const { send, platform } = await bootPlatform({ people });
  const put = (tenant: string, name: string, value: unknown, as = 'admin') =>
    send(`/tenants/${tenant}/secrets/${name}`, as, {
      method: 'PUT',
      body: { value, allowedHosts: hosts },
      reason: 'Klienthemmelighet for innlogging',
    });
  return { send, put, platform };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tenant secret limits', () => {
  it('a new secret name is lowercase letters, digits and hyphens, at most 63 characters', async () => {
    const { put, platform } = await boot();

    const refused = await Promise.all(
      ['Ansattporten', 'client.secret', 'client_secret', '-start', 'a'.repeat(64), 'æøå'].map(
        (name) => put(digdir, name, marker),
      ),
    );
    const accepted = await Promise.all(
      ['ansattporten-client-secret', 'github-read', 'a'.repeat(63), '0'].map((name) =>
        put(digdir, name, marker),
      ),
    );

    expect(refused.map((r) => r.status)).toEqual(refused.map(() => 400));
    expect(await refused[0]?.json()).toMatchObject({ errors: [{ path: 'name' }] });
    expect(accepted.map((r) => r.status)).toEqual(accepted.map(() => 200));
    expect(await platform.vault.names(digdir)).toEqual(
      ['0', 'a'.repeat(63), 'ansattporten-client-secret', 'github-read'].sort(),
    );
  });

  it('a secret stored under an older name can still get a new value', async () => {
    const { put, platform } = await boot();
    await platform.vault.set(digdir, 'gammel_nokkel', 'gammel', hosts);

    const replaced = await put(digdir, 'gammel_nokkel', 'ny');

    expect(replaced.status).toBe(200);
  });

  it('a value up to 16384 bytes is stored and one byte more is refused', async () => {
    const { put, platform } = await boot();

    const atLimit = await put(digdir, 'pem-key', 'x'.repeat(maxTenantSecretBytes));
    const overLimit = await put(digdir, 'for-stor', 'x'.repeat(maxTenantSecretBytes + 1));
    const multiByte = await put(digdir, 'flerbyte', 'æ'.repeat(maxTenantSecretBytes / 2 + 1));

    expect(atLimit.status).toBe(200);
    expect(overLimit.status).toBe(400);
    expect(await overLimit.json()).toMatchObject({ errors: [{ path: 'value' }] });
    expect(multiByte.status).toBe(400);
    expect(await platform.vault.names(digdir)).toEqual(['pem-key']);
  });

  it('a request body over the size limit is refused before it is read', async () => {
    const { put } = await boot();

    const refused = await put(digdir, 'enorm', 'x'.repeat(maxTenantSecretBytes * 5));

    expect(refused.status).toBe(413);
  });

  it('an organisation cannot have more than the secret limit, but can replace one it has', async () => {
    const { put, platform } = await boot();
    for (let i = 0; i < maxTenantSecrets; i++)
      await platform.vault.set(digdir, `nokkel-${i}`, 'v', hosts);

    const added = await put(digdir, 'en-til', marker);
    const replaced = await put(digdir, 'nokkel-0', 'ny');

    expect(added.status).toBe(409);
    expect(replaced.status).toBe(200);
    expect(await platform.vault.names(digdir)).not.toContain('en-til');
  });

  it('a member without the right gets 403 before the name rule and the secret limit', async () => {
    const { put, platform } = await boot();

    const badName = await put(digdir, 'Ugyldig.Navn', marker, 'leser');
    for (let i = 0; i < maxTenantSecrets; i++)
      await platform.vault.set(digdir, `nokkel-${i}`, 'v', hosts);
    const pastLimit = await put(digdir, 'en-til', marker, 'leser');

    expect(badName.status).toBe(403);
    expect(pastLimit.status).toBe(403);
  });

  it("a tenant cannot write another tenant's secret or a platform secret", async () => {
    const { put, platform } = await boot();

    const otherTenant = await put(other, 'egen', marker);
    const platformOwner = await put('platform', 'enhetsregisteret', marker);
    const operatorAsTenant = await put(digdir, 'operator-nokkel', marker, 'drift');

    expect(otherTenant.status).toBe(404);
    expect(platformOwner.status).toBe(404);
    expect(operatorAsTenant.status).toBe(404);
    expect(await platform.vault.names(other)).toEqual([]);
    expect(await platform.vault.names('platform')).toEqual([]);
    expect(await platform.vault.names(digdir)).toEqual([]);
  });

  it('the vault refuses a write that skips the route checks', async () => {
    const { platform } = await boot();

    await expect(platform.vault.set('platform/../x', 'navn', 'v')).rejects.toThrow();
    await expect(platform.vault.set(digdir, '../annen', 'v')).rejects.toThrow();
    await expect(
      platform.vault.set(digdir, 'stor', 'x'.repeat(maxTenantSecretBytes + 1)),
    ).rejects.toThrow();
    expect(await platform.vault.names(digdir)).toEqual([]);
  });

  it('the value never appears in an error, a log line or the audit log', async () => {
    const written: string[] = [];
    const capture = (...args: unknown[]) => {
      written.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, method).mockImplementation(capture);
    const { put, send } = await boot();
    const bigValue = `${marker}${'x'.repeat(maxTenantSecretBytes)}`;

    const answers = [
      await put(digdir, 'Ugyldig.Navn', marker),
      await put(digdir, 'for-stor', bigValue),
      await put(other, 'annen', marker),
      await put(digdir, 'lagret', marker),
    ];
    const bodies = await Promise.all(answers.map((r) => r.text()));
    const audit = await (await send(`/tenants/${digdir}/audit`, 'admin')).text();

    expect(answers.map((r) => r.status)).toEqual([400, 400, 404, 200]);
    expect(audit).toContain('lagret');
    for (const text of [...bodies, audit, ...written]) expect(text).not.toContain(marker);
  });
});
