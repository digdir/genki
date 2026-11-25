import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { bootPlatform, digdir, files, other, testService } from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: other,
    authorizedFor: [{ org: other, actions: ['read', 'use-services'] }],
  },
};

const reason = 'Rydder bort en blokk ingen bruker';

const block = (tenant: string, id: string, sharing = 'organisation') => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant, id, name: id },
  spec: {
    tier: 'declarative',
    title: { nb: id },
    zones: ['main'],
    sharing,
    texts: { nb: { hello: 'Hei' } },
    template: {
      version: 1,
      root: { type: 'card', children: [{ type: 'paragraph', text: [{ t: 'hello' }] }] },
    },
  },
});

const withLayout = (id: string, tenant: string) => {
  const service = testService(id, tenant);
  return {
    ...service,
    spec: {
      ...service.spec,
      interface: { layout: { version: 1, zones: { primary: [], main: [], secondary: [] } } },
    },
  };
};

const pinning = (id: string, tenant: string, blockId: string) => {
  const service = withLayout(id, tenant);
  return {
    ...service,
    spec: {
      ...service.spec,
      interface: {
        layout: {
          version: 1,
          zones: {
            primary: [],
            main: [{ block: 'ref', ref: `${tenant}/${blockId}@1` }],
            secondary: [],
          },
        },
      },
    },
  };
};

const boot = async (studio = true) => {
  const booted = await bootPlatform({
    people,
    ...(studio ? { envFlags: ['blockStudio' as const] } : {}),
  });
  for (const orgNumber of [digdir, other])
    await booted.platform.directory.ensure(
      { orgNumber, name: `Virksomhet ${orgNumber}`, status: 'active' },
      'platform:seed',
    );
  const seed = async (definition: unknown, withFiles: Record<string, string> = {}) => {
    const published = await booted.platform.definitions.publish(
      definition,
      'platform:seed',
      'oppsett',
      withFiles,
    );
    if (!published.ok) throw new Error(JSON.stringify(published.errors));
  };
  const save = async (who: string, definition: unknown) => {
    const response = await booted.send('/definitions', who, {
      body: { definition, files: {} },
      reason: 'ny utgave av kortet',
    });
    expect(response.status, await response.clone().text()).toBe(201);
  };
  const archive = (id: string, as = 'ola', tenant = other, withReason = reason) =>
    booted.send(`/tenants/${tenant}/blocks/${id}`, as, {
      method: 'DELETE',
      ...(withReason ? { reason: withReason } : {}),
    });
  const listed = async (as = 'ola', tenant = other) =>
    (
      (await (await booted.send(`/tenants/${tenant}/blocks`, as)).json()) as {
        data: { id: string }[];
      }
    ).data.map((b) => b.id);
  const pin = (as: string, tenant: string, service: string, publisher: string, id: string) =>
    booted.send(`/tenants/${tenant}/services/${service}/draft/blocks/${publisher}/${id}`, as, {
      method: 'PUT',
      body: { version: 1 },
      reason: 'Legger blokken i testutgaven',
    });
  return { ...booted, seed, save, archive, listed, pin };
};

describe("archiving an organisation's own block", () => {
  it('archives an unused block, audits it with the reason and stops listing it', async () => {
    const { save, archive, listed, send, admin } = await boot();
    await save('ola', block(other, 'kort'));

    const archived = await archive('kort');

    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ id: 'kort', archived: true, version: 1 });
    expect(await listed()).not.toContain('kort');
    expect((await send(`/tenants/${other}/blocks/${other}/kort`, 'ola')).status).toBe(404);
    expect(
      (await admin.audit(other)).find((a) => a.action === 'platform.block.archive'),
    ).toMatchObject({
      outcome: 'applied',
      target: 'block:kort',
      reason,
      actor: 'employee:test:ola',
    });
  });

  it('keeps the editions of an archived block and lists it again once a new edition is saved', async () => {
    const { save, archive, listed, send } = await boot();
    await save('ola', block(other, 'kort'));
    await archive('kort');

    await save('ola', block(other, 'kort'));

    expect(await listed()).toContain('kort');
    const detail = (await (await send(`/tenants/${other}/blocks/${other}/kort`, 'ola')).json()) as {
      editions: unknown[];
    };
    expect(detail.editions).toHaveLength(2);
  });

  it("refuses with 409 a block a service's testutgave pins, and names the service by its name", async () => {
    const { save, seed, archive, listed, pin } = await boot();
    await save('ola', block(other, 'kort'));
    await seed(withLayout('svarer', other), files);
    expect((await pin('ola', other, 'svarer', other, 'kort')).status).toBe(200);

    const refused = await archive('kort');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      type: 'urn:genai:problem:block-in-use',
      usedBy: [{ tenant: other, service: 'svarer' }],
      errors: [{ path: 'usedBy', message: expect.stringContaining('Klarspråk') }],
    });
    expect(await listed()).toContain('kort');
  });

  it('refuses with 409 a block the published version of a service pins, with no draft', async () => {
    const { save, seed, archive } = await boot();
    await save('ola', block(other, 'kort'));
    const service = withLayout('svarer', other);
    await seed(
      {
        ...service,
        spec: {
          ...service.spec,
          interface: {
            layout: {
              version: 1,
              zones: {
                primary: [],
                main: [{ block: 'ref', ref: `${other}/kort@1` }],
                secondary: [],
              },
            },
          },
        },
      },
      files,
    );

    const refused = await archive('kort');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ usedBy: [{ tenant: other, service: 'svarer' }] });
  });

  it('refuses to archive a block pinned only in a service draft', async () => {
    const { save, archive, send } = await boot();
    await save('ola', block(other, 'kort'));
    const drafted = await send(`/tenants/${other}/services/utkast/draft`, 'ola', {
      method: 'PUT',
      body: { definition: pinning('utkast', other, 'kort'), files },
      reason: 'Nytt utkast med kortet',
    });
    expect(drafted.status, await drafted.clone().text()).toBe(200);

    const refused = await archive('kort');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ usedBy: [{ tenant: other, service: 'utkast' }] });
  });

  it("refuses with 409 a block shared with everyone that another organisation's service pins, without naming it", async () => {
    const { seed, archive, pin } = await boot();
    await seed(block(other, 'delt', 'everyone'));
    await seed(withLayout('hemmelig-tjeneste', digdir), files);
    expect((await pin('kari', digdir, 'hemmelig-tjeneste', other, 'delt')).status).toBe(200);

    const refused = await archive('delt');
    const body = await refused.text();

    expect(refused.status).toBe(409);
    expect(body).not.toContain('hemmelig-tjeneste');
    expect(JSON.parse(body)).toMatchObject({ usedBy: [], otherServices: 1 });
  });

  it('refuses to pin an archived block', async () => {
    const { save, seed, archive, pin } = await boot();
    await save('ola', block(other, 'kort'));
    await seed(withLayout('svarer', other), files);
    await archive('kort');

    expect((await pin('ola', other, 'svarer', other, 'kort')).status).toBe(404);
  });

  it("answers 404 for genki's built-in block and another organisation's block", async () => {
    const { seed, archive } = await boot();
    await seed({
      ...block(digdir, 'samtale', 'everyone'),
      spec: {
        tier: 'built-in',
        builtIn: 'chat',
        title: { nb: 'Samtale' },
        zones: ['main'],
        sharing: 'everyone',
      },
    });
    await seed(block(digdir, 'digdirs', 'everyone'));

    expect((await archive('samtale', 'kari', digdir)).status).toBe(404);
    expect((await archive('digdirs')).status).toBe(404);
  });

  it('refuses an archive without a reason or without manage-services', async () => {
    const { save, archive } = await boot();
    await save('ola', block(other, 'kort'));

    expect((await archive('kort', 'ola', other, '')).status).toBe(400);
    expect((await archive('kort', 'erik')).status).toBe(403);
  });

  it('answers 404 while blockStudio is off for the caller', async () => {
    const { seed, archive, listed } = await boot(false);
    await seed(block(other, 'kort'));

    expect((await archive('kort')).status).toBe(404);
    expect(await listed()).toContain('kort');
  });
});

describe('a reference to an archived block', () => {
  it('is refused when a service draft places it', async () => {
    const { save, archive, send } = await boot();
    await save('ola', block(other, 'kort'));
    await archive('kort');

    const refused = await send(`/tenants/${other}/services/utkast/draft`, 'ola', {
      method: 'PUT',
      body: { definition: pinning('utkast', other, 'kort'), files },
      reason: 'Nytt utkast med kortet',
    });

    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      errors: [{ path: 'spec.interface.layout.zones.main[0].ref' }],
    });
  });

  it('is refused when POST /definitions publishes it', async () => {
    const { save, archive, send } = await boot();
    await save('ola', block(other, 'kort'));
    await archive('kort');

    const refused = await send('/definitions', 'ola', {
      body: { definition: pinning('svarer', other, 'kort'), files },
      reason: 'Publiserer med kortet',
    });

    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toContain(
      'spec.interface.layout.zones.main[0].ref',
    );
  });
});
