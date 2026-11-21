import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { bootPlatform, digdir, files, other, testService } from './testkit.js';

const third = '405003309';

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

const block = (tenant: string, id: string, spec: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant, id, name: id },
  spec: {
    tier: 'built-in',
    builtIn: 'chat',
    title: { nb: id, en: id },
    zones: ['main', 'secondary'],
    sharing: 'everyone',
    ...spec,
  },
});

const withLayout = (id: string, tenant: string, main: Record<string, unknown>[] = []) => {
  const service = testService(id, tenant);
  return {
    ...service,
    spec: {
      ...service.spec,
      interface: {
        layout: { version: 1, zones: { primary: [{ block: 'threads' }], main, secondary: [] } },
      },
    },
  };
};

interface Summary {
  publisher: string;
  id: string;
  origin: string;
  editions: number;
  usedBy: number;
}

const boot = async () => {
  const booted = await bootPlatform({ people });
  for (const orgNumber of [digdir, other, third])
    await booted.platform.directory.ensure(
      { orgNumber, name: `Virksomhet ${orgNumber}`, status: 'active' },
      'platform:seed',
    );
  const seed = async (definition: unknown) => {
    const published = await booted.platform.definitions.publish(
      definition,
      'platform:seed',
      'blokk til test',
    );
    if (!published.ok) throw new Error(JSON.stringify(published.errors));
  };
  await seed(block(digdir, 'chat'));
  const publish = async (who: string, definition: unknown) => {
    const response = await booted.send('/definitions', who, {
      body: { definition, files },
      reason: 'første versjon',
    });
    if (response.status !== 201) throw new Error(await response.text());
  };
  const list = async (who: string, tenant: string) =>
    ((await (await booted.send(`/tenants/${tenant}/blocks`, who)).json()) as { data: Summary[] })
      .data;
  const pin = (who: string, tenant: string, service: string, ref: string, body: unknown) =>
    booted.send(`/tenants/${tenant}/services/${service}/draft/blocks/${ref}`, who, {
      method: 'PUT',
      body,
      reason: 'La blokken i testutgaven',
    });
  const draftOf = async (tenant: string, service: string) =>
    (await (await booted.send(`/tenants/${tenant}/services/${service}/draft`, 'ola')).json()) as {
      definition: { spec: { interface: { layout: { zones: Record<string, unknown[]> } } } };
    } | null;
  return { ...booted, seed, publish, list, pin, draftOf };
};

describe('the blocks an organisation may use', () => {
  it("lists the organisation's own blocks, genki's built-in blocks and blocks shared with everyone", async () => {
    const { seed, list } = await boot();
    await seed(block(other, 'egen', { sharing: 'organisation' }));
    await seed(block(third, 'delt'));

    const blocks = await list('ola', other);

    expect(blocks.map((b) => [b.publisher, b.id, b.origin])).toEqual([
      [other, 'egen', 'own'],
      [digdir, 'chat', 'built-in'],
      [third, 'delt', 'shared'],
    ]);
  });

  it('lists only the blocks of the origin asked for', async () => {
    const { seed, list, send } = await boot();
    await seed(block(other, 'egen'));
    await seed(block(third, 'delt'));

    const shared = (await (await send(`/tenants/${other}/blocks?origin=shared`, 'ola')).json()) as {
      data: Summary[];
    };

    expect(shared.data.map((b) => b.id)).toEqual(['delt']);
    expect((await list('ola', other)).map((b) => b.id)).toEqual(['egen', 'chat', 'delt']);
  });

  it("hides another organisation's block that is not shared with everyone", async () => {
    const { seed, list, send } = await boot();
    await seed(block(third, 'privat', { sharing: 'private' }));
    await seed(block(third, 'intern', { sharing: 'organisation' }));

    const blocks = await list('ola', other);
    const read = await send(`/tenants/${other}/blocks/${third}/intern`, 'ola');

    expect(blocks.map((b) => b.id)).toEqual(['chat']);
    expect(read.status).toBe(404);
  });

  it("shows another organisation's block only in the editions it shared with everyone", async () => {
    const { seed, list, send } = await boot();
    await seed(block(third, 'kart', { sharing: 'private' }));
    await seed(block(third, 'kart'));
    await seed(block(third, 'kart', { sharing: 'organisation' }));

    const listed = (await list('ola', other)).find((b) => b.id === 'kart');
    const detail = (await (await send(`/tenants/${other}/blocks/${third}/kart`, 'ola')).json()) as {
      editions: { version: number }[];
      edition: { version: number };
    };
    const hidden = await send(`/tenants/${other}/blocks/${third}/kart?version=1`, 'ola');

    expect(listed).toMatchObject({ editions: 1, latest: { version: 2 } });
    expect(detail.editions.map((e) => e.version)).toEqual([2]);
    expect(detail.edition.version).toBe(2);
    expect(hidden.status).toBe(404);
  });

  it('names who published an edition only to the organisation that published it', async () => {
    const { seed, send } = await boot();
    await seed(block(other, 'egen'));
    const detail = async (publisher: string, id: string) =>
      (
        (await (await send(`/tenants/${other}/blocks/${publisher}/${id}`, 'ola')).json()) as {
          edition: Record<string, unknown>;
        }
      ).edition;

    expect(await detail(other, 'egen')).toHaveProperty('publishedBy', 'platform:seed');
    expect(await detail(digdir, 'chat')).not.toHaveProperty('publishedBy');
  });

  it('refuses the block list of an organisation the caller is not in', async () => {
    const { send } = await boot();

    expect((await send(`/tenants/${digdir}/blocks`, 'ola')).status).toBe(404);
    expect((await send(`/tenants/${digdir}/blocks/${digdir}/chat`, 'ola')).status).toBe(404);
  });

  it("counts only the caller's own services as users of a block", async () => {
    const { publish, list, send } = await boot();
    const pinned = [{ block: 'chat', ref: `${digdir}/chat@1` }];
    await publish('kari', withLayout('digdir-tjeneste', digdir, pinned));
    await publish('ola', withLayout('var-tjeneste', other, pinned));

    const chat = (await list('ola', other)).find((b) => b.id === 'chat');
    const detail = (await (
      await send(`/tenants/${other}/blocks/${digdir}/chat`, 'ola')
    ).json()) as {
      usedIn: unknown[];
    };

    expect(chat?.usedBy).toBe(1);
    expect(detail.usedIn).toEqual([
      { service: 'var-tjeneste', name: 'Klarspråk', test: 1, inUse: 1 },
    ]);
  });
});

describe('a preview of a block', () => {
  const declarative = block(other, 'sporsmal-kort', {
    tier: 'declarative',
    builtIn: undefined,
    template: { version: 1 },
    states: ['empty', 'filled'],
  });

  it("previews an unsaved block with genki's fixtures and saves nothing", async () => {
    const { send, platform } = await boot();

    const response = await send(`/tenants/${other}/blocks/preview`, 'ola', {
      body: { definition: declarative, states: ['filled'] },
    });
    const body = (await response.json()) as {
      valid: boolean;
      errors: { path: string }[];
      fixtures: Record<string, { question?: { text?: string } }>;
    };

    expect(response.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.errors.map((e) => e.path)).toEqual(['spec.tier']);
    expect(Object.keys(body.fixtures)).toEqual(['filled']);
    expect(body.fixtures.filled?.question?.text).toBe('Hva er klarspråk?');
    expect(await platform.definitions.list(other)).toEqual([]);
  });

  it('refuses a preview of anything but a block', async () => {
    const { send } = await boot();

    const refused = await send(`/tenants/${other}/blocks/preview`, 'ola', {
      body: { definition: testService('klarsprak', other) },
    });

    expect(refused.status).toBe(422);
  });

  it('refuses a preview of a block for another organisation', async () => {
    const { send } = await boot();

    const inOwnName = await send(`/tenants/${other}/blocks/preview`, 'ola', {
      body: { definition: block(digdir, 'lant') },
    });
    const inTheirs = await send(`/tenants/${digdir}/blocks/preview`, 'ola', {
      body: { definition: block(digdir, 'lant') },
    });

    expect(inOwnName.status).toBe(403);
    expect(inTheirs.status).toBe(404);
  });

  it('refuses a preview without manage-services', async () => {
    const { send } = await boot();

    const refused = await send(`/tenants/${other}/blocks/preview`, 'erik', {
      body: { definition: declarative },
    });

    expect(refused.status).toBe(403);
  });
});

describe("a block in a service's testutgave", () => {
  it("puts an edition in the service's testutgave and leaves the version in use as it was", async () => {
    const { publish, pin, draftOf, send } = await boot();
    await publish('ola', withLayout('klarsprak', other));

    const pinned = await pin('ola', other, 'klarsprak', `${digdir}/chat`, {
      version: 1,
      zone: 'main',
    });
    const published = (await (
      await send(`/tenants/${other}/definitions/services/klarsprak`, 'ola')
    ).json()) as { latest: { version: number; definition: { spec: { interface: unknown } } } };

    expect(pinned.status).toBe(200);
    expect(
      (await draftOf(other, 'klarsprak'))?.definition.spec.interface.layout.zones.main,
    ).toEqual([{ block: 'chat', ref: `${digdir}/chat@1` }]);
    expect(published.latest.version).toBe(1);
    expect(published.latest.definition.spec.interface).toMatchObject({
      layout: { zones: { main: [] } },
    });
  });

  it('puts a block given no zone in the first zone it may stand in, and starts the testutgave from the version in use', async () => {
    const { seed, publish, pin, draftOf } = await boot();
    await seed(block(other, 'sidekort', { zones: ['secondary', 'main'] }));
    await publish('ola', withLayout('klarsprak', other));

    const pinned = await pin('ola', other, 'klarsprak', `${other}/sidekort`, { version: 1 });
    const draft = await draftOf(other, 'klarsprak');

    expect(((await pinned.json()) as { baseVersion: number }).baseVersion).toBe(1);
    expect(draft?.definition.spec.interface.layout.zones.secondary).toEqual([
      { block: 'chat', ref: `${other}/sidekort@1` },
    ]);
  });

  it('keeps a block at its place in the zone when it moves to another edition', async () => {
    const { seed, publish, pin, draftOf } = await boot();
    await seed(block(digdir, 'chat'));
    await seed(block(digdir, 'kort'));
    await publish('ola', withLayout('klarsprak', other, [{ block: 'approach' }]));
    await pin('ola', other, 'klarsprak', `${digdir}/chat`, { version: 1, zone: 'main' });
    await pin('ola', other, 'klarsprak', `${digdir}/kort`, { version: 1, zone: 'main' });

    await pin('ola', other, 'klarsprak', `${digdir}/chat`, { version: 2 });

    expect(
      (await draftOf(other, 'klarsprak'))?.definition.spec.interface.layout.zones.main,
    ).toEqual([
      { block: 'approach' },
      { block: 'chat', ref: `${digdir}/chat@2` },
      { block: 'chat', ref: `${digdir}/kort@1` },
    ]);
  });

  it('counts a block in the testutgave as used in the draft', async () => {
    const { publish, pin, send } = await boot();
    await publish('ola', withLayout('klarsprak', other));
    await pin('ola', other, 'klarsprak', `${digdir}/chat`, { version: 1, zone: 'main' });

    const detail = (await (
      await send(`/tenants/${other}/blocks/${digdir}/chat`, 'ola')
    ).json()) as { usedIn: { service: string; draft?: number }[] };

    expect(detail.usedIn).toEqual([expect.objectContaining({ service: 'klarsprak', draft: 1 })]);
  });

  it('moves a block already in the testutgave to the chosen edition', async () => {
    const { seed, publish, pin, draftOf } = await boot();
    const props = { type: 'object', properties: { footnotes: { type: 'boolean' } } };
    await seed(block(digdir, 'chat', { props }));
    await seed(block(digdir, 'chat', { props }));
    await publish('ola', withLayout('klarsprak', other, [{ block: 'approach' }]));

    await pin('ola', other, 'klarsprak', `${digdir}/chat`, {
      version: 2,
      zone: 'main',
      settings: { footnotes: true },
    });
    const moved = await pin('ola', other, 'klarsprak', `${digdir}/chat`, { version: 3 });

    expect(moved.status).toBe(200);
    expect(
      (await draftOf(other, 'klarsprak'))?.definition.spec.interface.layout.zones.main,
    ).toEqual([
      { block: 'approach' },
      { block: 'chat', ref: `${digdir}/chat@3`, settings: { footnotes: true } },
    ]);
  });

  it('takes a block out of the testutgave', async () => {
    const { publish, pin, draftOf, send } = await boot();
    await publish('ola', withLayout('klarsprak', other));
    await pin('ola', other, 'klarsprak', `${digdir}/chat`, { version: 1 });

    const removed = await send(
      `/tenants/${other}/services/klarsprak/draft/blocks/${digdir}/chat`,
      'ola',
      { method: 'DELETE', reason: 'Tar blokken ut av testutgaven' },
    );

    expect(removed.status).toBe(200);
    expect(
      (await draftOf(other, 'klarsprak'))?.definition.spec.interface.layout.zones.main,
    ).toEqual([]);
  });

  it('takes a block out of a service with no testutgave by starting one from the version in use', async () => {
    const { publish, send, draftOf } = await boot();
    await publish(
      'ola',
      withLayout('klarsprak', other, [{ block: 'chat', ref: `${digdir}/chat@1` }]),
    );

    const removed = await send(
      `/tenants/${other}/services/klarsprak/draft/blocks/${digdir}/chat`,
      'ola',
      { method: 'DELETE', reason: 'Tar blokken ut av testutgaven' },
    );

    expect(removed.status).toBe(200);
    expect(
      (await draftOf(other, 'klarsprak'))?.definition.spec.interface.layout.zones.main,
    ).toEqual([]);
  });

  it('answers 404 when the block is not in the testutgave or the service does not exist', async () => {
    const { publish, pin, send } = await boot();
    await publish('ola', withLayout('klarsprak', other));

    const notPinned = await send(
      `/tenants/${other}/services/klarsprak/draft/blocks/${digdir}/chat`,
      'ola',
      { method: 'DELETE', reason: 'Tar blokken ut av testutgaven' },
    );
    const noService = await pin('ola', other, 'finnes-ikke', `${digdir}/chat`, { version: 1 });

    expect(notPinned.status).toBe(404);
    expect(noService.status).toBe(404);
  });

  it('refuses a pin with a version, zone or settings of the wrong shape', async () => {
    const { publish, pin, draftOf } = await boot();
    await publish('ola', withLayout('klarsprak', other));

    const bodies = [
      { version: 0 },
      { version: 1, zone: 'footer' },
      { version: 1, settings: { n: 1 } },
    ];
    const statuses = await Promise.all(
      bodies.map(
        async (body) => (await pin('ola', other, 'klarsprak', `${digdir}/chat`, body)).status,
      ),
    );

    expect(statuses).toEqual([400, 400, 400]);
    expect(await draftOf(other, 'klarsprak')).toBeNull();
  });

  it('refuses to pin into a service that has no layout', async () => {
    const { publish, pin, draftOf } = await boot();
    await publish('ola', testService('uten-utforming', other));

    const refused = await pin('ola', other, 'uten-utforming', `${digdir}/chat`, { version: 1 });

    expect(refused.status).toBe(422);
    expect(await draftOf(other, 'uten-utforming')).toBeNull();
  });

  it("refuses to pin another organisation's block that is not shared with everyone", async () => {
    const { seed, publish, pin, draftOf } = await boot();
    await seed(block(third, 'privat', { sharing: 'organisation' }));
    await publish('ola', withLayout('klarsprak', other));

    const refused = await pin('ola', other, 'klarsprak', `${third}/privat`, { version: 1 });

    expect(refused.status).toBe(404);
    expect(await draftOf(other, 'klarsprak')).toBeNull();
  });

  it('refuses to pin an edition in a zone it cannot stand in', async () => {
    const { publish, pin, draftOf } = await boot();
    await publish('ola', withLayout('klarsprak', other));

    const refused = await pin('ola', other, 'klarsprak', `${digdir}/chat`, {
      version: 1,
      zone: 'primary',
    });

    expect(refused.status).toBe(422);
    expect(await draftOf(other, 'klarsprak')).toBeNull();
  });

  it('audits a pin and taking it out as saves of the draft, with the reason', async () => {
    const { publish, pin, send, admin } = await boot();
    await publish('ola', withLayout('klarsprak', other));

    const pinned = await pin('ola', other, 'klarsprak', `${digdir}/chat`, { version: 1 });
    await send(`/tenants/${other}/services/klarsprak/draft/blocks/${digdir}/chat`, 'ola', {
      method: 'DELETE',
      reason: 'Tar blokken ut av testutgaven',
    });

    expect(pinned.headers.get('genai-task')).toBeTruthy();
    expect(
      (await admin.audit(other))
        .filter((a) => a.action === 'platform.service.draft.save')
        .map((a) => [a.outcome, a.target, a.reason]),
    ).toEqual([
      ['applied', 'service-draft:klarsprak', 'La blokken i testutgaven'],
      ['applied', 'service-draft:klarsprak', 'Tar blokken ut av testutgaven'],
    ]);
  });

  it('refuses to pin without manage-services', async () => {
    const { publish, pin } = await boot();
    await publish('ola', withLayout('klarsprak', other));

    const refused = await pin('erik', other, 'klarsprak', `${digdir}/chat`, { version: 1 });

    expect(refused.status).toBe(403);
  });

  it("refuses to pin in another organisation's service", async () => {
    const { publish, pin } = await boot();
    await publish('kari', withLayout('klarsprak', digdir));

    const refused = await pin('ola', digdir, 'klarsprak', `${digdir}/chat`, { version: 1 });

    expect(refused.status).toBe(404);
  });
});
