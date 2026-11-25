import type { Principal } from '@genai/contracts';
import { describe, expect, it, vi } from 'vitest';
import { bundleText, codeBlock } from './block-code.test-utils.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { bootPlatform, digdir, other } from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['read', 'use-services'] }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  vakt: { kind: 'operator', issuer: 'test', subject: 'vakt', tenant: other },
};

const files = { 'block/bundle.js': bundleText };

class SlowConfigEntries extends InMemoryConfigEntryStore {
  slow = false;
  private pause = () =>
    this.slow ? new Promise<void>((resolve) => setImmediate(resolve)) : Promise.resolve();
  override async latest(...args: Parameters<InMemoryConfigEntryStore['latest']>) {
    await this.pause();
    return super.latest(...args);
  }
  override async history(...args: Parameters<InMemoryConfigEntryStore['history']>) {
    await this.pause();
    return super.history(...args);
  }
}

const boot = async (studio = true) => {
  let clock = Date.parse('2026-11-21T09:00:00Z');
  const configEntries = new SlowConfigEntries();
  const booted = await bootPlatform({
    people,
    blockOrigin: 'https://blocks.example.test',
    ...(studio ? { envFlags: ['blockStudio' as const] } : {}),
    now: () => clock,
    configEntries,
  });
  const tick = (minutes: number) => {
    clock += minutes * 60_000;
  };
  const { send } = booted;
  for (const orgNumber of [digdir, other])
    await booted.platform.directory.ensure(
      { orgNumber, name: `Virksomhet ${orgNumber}`, status: 'active' },
      'platform:seed',
    );
  const save = async (definition: unknown = codeBlock(digdir)) => {
    const response = await send('/definitions', 'kari', {
      body: { definition, files },
      reason: 'ny utgave av figuren',
    });
    expect(response.status).toBe(201);
  };
  const ask = (version: number, who = 'kari', tenant = digdir) =>
    send(`/tenants/${tenant}/blocks/figur/share-requests`, who, {
      body: { version },
      reason: 'del figuren med alle',
    });
  const pending = async () =>
    (
      (await (await send('/operator/block-share-requests?status=pending', 'drift')).json()) as {
        data: { id: string; tenant: string; version: number; reads: string[] }[];
      }
    ).data;
  const decide = (id: string, decision: 'approve' | 'decline', who = 'drift') =>
    send(`/operator/block-share-requests/${id}/${decision}`, who, {
      body: {},
      reason: decision === 'approve' ? 'lest koden, trygg' : 'henter data den ikke trenger',
    });
  const sharingOf = async (version: number) =>
    (
      (await (
        await send(`/tenants/${digdir}/definitions/blocks/figur/versions/${version}`, 'kari')
      ).json()) as { definition: { spec: { sharing: string } } }
    ).definition.spec.sharing;
  const audit = async () =>
    (
      (await (await send(`/tenants/${digdir}/audit`, 'kari')).json()) as {
        data?: { action: string; reason: string }[];
      }
    ).data ?? [];
  const versionsOf = async () =>
    (
      (await (await send(`/tenants/${digdir}/definitions/blocks/figur`, 'kari')).json()) as {
        versions: unknown[];
      }
    ).versions.length;
  return {
    ...booted,
    save,
    ask,
    pending,
    decide,
    sharingOf,
    audit,
    versionsOf,
    tick,
    configEntries,
  };
};

describe('review before a code block is shared with everyone', () => {
  it('sends a code block to review instead of sharing it with everyone', async () => {
    const { save, ask, pending, sharingOf } = await boot();
    await save();

    const asked = await ask(1);

    expect(asked.status).toBe(201);
    expect(await asked.json()).toMatchObject({ status: 'pending', version: 1 });
    expect(await pending()).toMatchObject([
      { tenant: digdir, version: 1, reads: ['question.text'] },
    ]);
    expect(await sharingOf(1)).toBe('organisation');
  });

  it('shows the operator the bundle and the sources as text', async () => {
    const { save, ask, pending, send } = await boot();
    await save();
    await ask(1);
    const [request] = await pending();

    const detail = (await (
      await send(`/operator/block-share-requests/${request?.id}`, 'drift')
    ).json()) as { bundle: string; sources: Record<string, string> };

    expect(detail.bundle).toBe(bundleText);
    expect(detail.sources).toEqual({});
  });

  it('lets one operator approve, which saves a new edition shared with everyone', async () => {
    const { save, ask, pending, decide, sharingOf, send } = await boot();
    await save();
    await ask(1);
    const [request] = await pending();

    const approved = await decide(request?.id ?? '', 'approve');

    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: 'approved', version: 2 });
    expect(await sharingOf(2)).toBe('everyone');
    const nav = (await (await send(`/tenants/${other}/blocks/${digdir}/figur`, 'ola')).json()) as {
      editions: { version: number }[];
    };
    expect(nav.editions.map((e) => e.version)).toEqual([2]);
  });

  it('refuses an approval from anyone but an operator', async () => {
    const { save, ask, pending, decide, versionsOf } = await boot();
    await save();
    await ask(1);
    const [request] = await pending();

    for (const who of ['kari', 'ola', 'erik']) {
      const refused = await decide(request?.id ?? '', 'approve', who);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        type: 'urn:genai:problem:block-share-operator-only',
      });
    }
    expect((await decide(request?.id ?? '', 'decline', 'kari')).status).toBe(403);
    expect((await pending()).length).toBe(1);
    expect(await versionsOf()).toBe(1);
  });

  it('keeps the block as it was when an operator declines', async () => {
    const { save, ask, pending, decide, send } = await boot();
    await save();
    await ask(1);
    const [request] = await pending();

    const declined = await decide(request?.id ?? '', 'decline');

    expect(await declined.json()).toEqual({ status: 'declined' });
    const versions = (await (
      await send(`/tenants/${digdir}/definitions/blocks/figur`, 'kari')
    ).json()) as { versions: unknown[] };
    expect(versions.versions).toHaveLength(1);
    const detail = (await (
      await send(`/tenants/${digdir}/blocks/${digdir}/figur`, 'kari')
    ).json()) as {
      review: { status: string; reason: string };
    };
    expect(detail.review).toMatchObject({
      status: 'declined',
      reason: 'henter data den ikke trenger',
    });
    const again = await decide(request?.id ?? '', 'approve');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      type: 'urn:genai:problem:block-share-not-pending',
    });
  });

  it('needs a new review for every edition shared with everyone', async () => {
    const { save, ask, pending, decide, send } = await boot();
    await save();
    await ask(1);
    await decide((await pending())[0]?.id ?? '', 'approve');

    const sneaked = await send('/definitions', 'kari', {
      body: { definition: codeBlock(digdir, bundleText, { sharing: 'everyone' }), files },
      reason: 'ny figur til alle',
    });
    expect(sneaked.status).toBe(403);
    expect((await ask(2)).status).toBe(422);

    await save();
    expect((await ask(3)).status).toBe(201);
    expect((await pending()).map((r) => r.version)).toEqual([3]);
  });

  it('keeps one review at a time for a block', async () => {
    const { save, ask } = await boot();
    await save();
    await ask(1);

    const second = await ask(1);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ type: 'urn:genai:problem:block-share-pending' });
  });

  it('keeps one review at a time when two requests arrive together', async () => {
    const { save, ask, pending, configEntries } = await boot();
    await save();
    configEntries.slow = true;

    const statuses = (await Promise.all([ask(1), ask(1)])).map((r) => r.status).sort();

    expect(statuses).toEqual([201, 409]);
    expect(await pending()).toHaveLength(1);
  });

  it('sends only the newest edition to review', async () => {
    const { save, ask } = await boot();
    await save();
    await save();

    const older = await ask(1);

    expect(older.status).toBe(422);
    expect(await older.json()).toMatchObject({
      errors: [{ path: 'version', message: expect.stringContaining('nyeste') }],
    });
  });

  it('refuses to approve a request once a newer edition is saved, so nothing is rolled back', async () => {
    const { save, ask, pending, decide, versionsOf } = await boot();
    await save();
    await ask(1);
    await save();

    const approved = await decide((await pending())[0]?.id ?? '', 'approve');

    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ type: 'urn:genai:problem:block-share-stale' });
    expect(await versionsOf()).toBe(2);
  });

  it('refuses an approval when a newer edition is published between the check and the publish', async () => {
    const { save, ask, pending, decide, versionsOf, sharingOf, platform } = await boot();
    await save();
    await ask(1);
    const read = platform.definitions.get.bind(platform.definitions);
    let raced = false;
    vi.spyOn(platform.definitions, 'get').mockImplementation(async (kind, tenant, id, version) => {
      const found = await read(kind, tenant, id, version);
      if (!raced && kind === 'Block' && version === undefined) {
        raced = true;
        await save();
      }
      return found;
    });

    const approved = await decide((await pending())[0]?.id ?? '', 'approve');

    expect(raced).toBe(true);
    expect(approved.status).toBe(409);
    expect(await approved.json()).toMatchObject({ type: 'urn:genai:problem:block-share-stale' });
    expect(await versionsOf()).toBe(2);
    expect(await sharingOf(2)).toBe('organisation');
  });

  it('publishes one shared edition when one request is approved twice at once', async () => {
    const { save, ask, pending, decide, versionsOf, configEntries } = await boot();
    await save();
    await ask(1);
    const id = (await pending())[0]?.id ?? '';
    configEntries.slow = true;

    const statuses = (await Promise.all([decide(id, 'approve'), decide(id, 'approve')]))
      .map((r) => r.status)
      .sort();

    expect(statuses).toEqual([200, 409]);
    expect(await versionsOf()).toBe(2);
  });

  it('refuses a share request without a saved version number', async () => {
    const { save, send } = await boot();
    await save();

    for (const version of [undefined, 0, 1.5, '1'])
      expect(
        (
          await send(`/tenants/${digdir}/blocks/figur/share-requests`, 'kari', {
            body: { version },
            reason: 'del figuren med alle',
          })
        ).status,
      ).toBe(400);
  });

  it('dates requests and decisions by the platform clock and lists the oldest first', async () => {
    const { save, ask, pending, decide, send, tick } = await boot();
    await save();
    await ask(1);
    tick(30);
    await decide((await pending())[0]?.id ?? '', 'decline');

    const own = (await (
      await send(`/tenants/${digdir}/blocks/figur/share-requests`, 'kari')
    ).json()) as { data: { requestedAt: string; decidedAt: string }[] };

    expect(own.data[0]).toMatchObject({
      requestedAt: '2026-11-21T09:00:00.000Z',
      decidedAt: '2026-11-21T09:30:00.000Z',
    });
  });

  it('sends only an edition with code to review', async () => {
    const { ask, platform } = await boot();
    const saved = await platform.definitions.publish(
      {
        apiVersion: 'genai/v1',
        kind: 'Block',
        metadata: { tenant: digdir, id: 'figur', name: 'Figur' },
        spec: { tier: 'built-in', builtIn: 'chat', title: { nb: 'Figur' }, zones: ['main'] },
      },
      'platform:seed',
      'innebygd blokk',
    );
    expect(saved.ok).toBe(true);

    const asked = await ask(1);

    expect(asked.status).toBe(422);
    expect(await asked.json()).toMatchObject({
      errors: [{ path: 'version', message: expect.stringContaining('kode') }],
    });
  });

  it("writes every request, approval and decline to the organisation's audit log", async () => {
    const { save, ask, pending, decide, audit } = await boot();
    await save();
    await ask(1);
    await decide((await pending())[0]?.id ?? '', 'decline');
    await ask(1);
    await decide((await pending())[0]?.id ?? '', 'approve');

    const shares = (await audit()).filter((e) => e.action.startsWith('platform.block-share.'));

    expect(shares.map((e) => [e.action, e.reason])).toEqual(
      expect.arrayContaining([
        ['platform.block-share.request', 'del figuren med alle'],
        ['platform.block-share.decline', 'henter data den ikke trenger'],
        ['platform.block-share.approve', 'lest koden, trygg'],
      ]),
    );
    expect(shares.filter((e) => e.action === 'platform.block-share.request')).toHaveLength(2);
  });

  it("refuses one organisation's request to share another organisation's block", async () => {
    const { save, ask, pending } = await boot();
    await save();

    expect((await ask(1, 'ola', digdir)).status).toBe(404);
    expect((await ask(1, 'ola', other)).status).toBe(404);
    expect(await pending()).toEqual([]);
  });

  it("hides another organisation's requests from a tenant", async () => {
    const { save, ask, send } = await boot();
    await save();
    await ask(1);

    expect((await send(`/tenants/${digdir}/blocks/figur/share-requests`, 'ola')).status).toBe(404);
    expect((await send('/operator/block-share-requests', 'ola')).status).toBe(403);
    expect((await send('/operator/block-share-requests', 'kari')).status).toBe(403);
    const own = (await (
      await send(`/tenants/${digdir}/blocks/figur/share-requests`, 'kari')
    ).json()) as { data: unknown[] };
    expect(own.data).toHaveLength(1);
  });

  it('shows the bundle under review to operators only', async () => {
    const { save, ask, pending, send } = await boot();
    await save();
    await ask(1);
    const id = (await pending())[0]?.id ?? '';

    for (const who of ['kari', 'ola', 'erik'])
      expect((await send(`/operator/block-share-requests/${id}`, who)).status).toBe(403);
  });

  it("keeps a block's review from other organisations", async () => {
    const { save, ask, pending, decide, send } = await boot();
    await save();
    await ask(1);
    await decide((await pending())[0]?.id ?? '', 'approve');

    const seen = (await (await send(`/tenants/${other}/blocks/${digdir}/figur`, 'ola')).json()) as {
      review?: unknown;
    };

    expect(seen.review).toBeUndefined();
  });

  it('shows the organisation which operator decided, in its requests and its audit log', async () => {
    const { save, ask, pending, decide, send, audit } = await boot();
    await save();
    await ask(1);
    await decide((await pending())[0]?.id ?? '', 'approve');

    const own = (await (
      await send(`/tenants/${digdir}/blocks/figur/share-requests`, 'kari')
    ).json()) as { data: { decidedBy?: string }[] };
    const approval = (await audit()).find((e) => e.action === 'platform.block-share.approve') as
      { actor?: string } | undefined;

    expect(own.data[0]?.decidedBy).toContain('drift');
    expect(approval?.actor).toContain('drift');
  });

  it('refuses a share request without manage-services', async () => {
    const { save, ask } = await boot();
    await save();

    expect((await ask(1, 'erik')).status).toBe(403);
  });
});

const routes = [
  ['POST', `/tenants/${digdir}/blocks/figur/share-requests`, 'kari'],
  ['GET', `/tenants/${digdir}/blocks/figur/share-requests`, 'kari'],
  ['GET', '/operator/block-share-requests', 'vakt'],
  ['GET', '/operator/block-share-requests/:rid', 'vakt'],
  ['POST', '/operator/block-share-requests/:rid/approve', 'vakt'],
  ['POST', '/operator/block-share-requests/:rid/decline', 'vakt'],
] as const;

const studioIn = (booted: Awaited<ReturnType<typeof boot>>) => (tenant: string, on: boolean) =>
  booted.platform.flags.set({
    tenant,
    key: 'blockStudio',
    on,
    by: 'operator:test:drift',
    reason: 'prøver ny utforming',
  });

const asked = async () => {
  const booted = await boot(false);
  const studio = studioIn(booted);
  await studio(digdir, true);
  await studio(other, true);
  await booted.save();
  expect((await booted.ask(1)).status).toBe(201);
  const [request] = await booted.pending();
  expect(request).toBeDefined();
  return { ...booted, studio, rid: request?.id ?? '' };
};

describe('share requests behind the blockStudio flag', () => {
  it.each(routes)('answers 404 on %s %s while blockStudio is off', async (method, path, who) => {
    const { send, studio, rid } = await asked();
    await studio(who === 'vakt' ? other : digdir, false);

    const response = await send(path.replace(':rid', rid), who, {
      method,
      ...(method === 'POST' ? { body: { version: 1 }, reason: 'del figuren med alle' } : {}),
    });

    expect(response.status).toBe(404);
  });

  it("refuses an approval while blockStudio is off for the block's organisation", async () => {
    const { decide, studio, rid, versionsOf } = await asked();
    await studio(digdir, false);

    const refused = await decide(rid, 'approve', 'vakt');

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      type: 'urn:genai:problem:block-share-studio-off',
      title: 'Ny utforming er ikke slått på for hele virksomheten som eier designelementet',
    });
    expect(await versionsOf()).toBe(1);
  });
});
