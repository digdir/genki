import { describe, expect, it } from 'vitest';
import { blockPublisherProblems, shareOperatorOnlyType } from './admin.js';
import { digdir, files, klarsprak, principals, setup } from './testkit.js';

const block = (spec: Record<string, unknown> = {}) => ({
  apiVersion: 'genai/v1',
  kind: 'Block',
  metadata: { tenant: digdir, id: 'chat', name: 'Chat' },
  spec: {
    tier: 'built-in',
    builtIn: 'chat',
    title: { nb: 'Chat', en: 'Chat' },
    zones: ['main', 'secondary'],
    sharing: 'everyone',
    ...spec,
  },
});

const publishing =
  (send: ReturnType<typeof setup>['send']) =>
  (who: string, definition: unknown, reason = 'første versjon', session?: string) =>
    send('/definitions', who, {
      body: { definition },
      reason,
      ...(session ? { session } : {}),
    });

const supportSession = async (send: ReturnType<typeof setup>['send']) => {
  const opened = await send('/support-sessions', 'operator', {
    body: { tenant: digdir, reason: 'genkis egne blokker', minutes: 30 },
  });
  return ((await opened.json()) as { id: string }).id;
};

describe('Block definitions through the definition API', () => {
  it('lets an operator publish a built-in block with a reason, as versions with an audit entry', async () => {
    const { send, admin } = setup();
    const publish = publishing(send);
    const session = await supportSession(send);

    const first = await publish('operator', block(), 'genkis chat som blokk', session);
    const second = await publish(
      'operator',
      block({ zones: ['main'] }),
      'chat bare i midten',
      session,
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('location')).toBe(
      `/tenants/${digdir}/definitions/blocks/chat/versions/2`,
    );
    const overview = (await (
      await send(`/tenants/${digdir}/definitions/blocks/chat`, 'kari')
    ).json()) as { kind: string; latest: { version: number }; versions: { reason: string }[] };
    expect(overview.kind).toBe('Block');
    expect(overview.latest.version).toBe(2);
    expect(overview.versions.map((v) => v.reason)).toEqual([
      'genkis chat som blokk',
      'chat bare i midten',
    ]);
    const pinned = (await (
      await send(`/tenants/${digdir}/definitions/blocks/chat/versions/1`, 'kari')
    ).json()) as { definition: { spec: { zones: string[] } } };
    expect(pinned.definition.spec.zones).toEqual(['main', 'secondary']);
    expect((await admin.audit(digdir)).at(-1)).toMatchObject({
      action: 'platform.service.publish',
      outcome: 'applied',
      target: 'Block:chat@2',
      reason: 'chat bare i midten',
    });
  });

  it("refuses a built-in block from anyone but an operator, since the built-in blocks are genki's", async () => {
    const { send, admin } = setup();
    const publish = publishing(send);

    const refused = await publish('kari', block({ sharing: 'private' }));

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      type: shareOperatorOnlyType,
      errors: [{ path: 'spec.tier' }],
    });
    expect((await send(`/tenants/${digdir}/definitions/blocks/chat`, 'kari')).status).toBe(404);
    expect((await admin.audit(digdir)).at(-1)).toMatchObject({
      action: 'platform.service.publish',
      outcome: 'rejected',
    });
  });

  it('refuses a block publish without a reason', async () => {
    const { send } = setup();
    const publish = publishing(send);
    const session = await supportSession(send);

    const refused = await publish('operator', block(), '', session);

    expect(refused.status).toBe(400);
  });

  it("hides a tenant's blocks from another tenant", async () => {
    const { send } = setup();
    const publish = publishing(send);
    await publish('operator', block(), 'genkis chat som blokk', await supportSession(send));

    expect((await send(`/tenants/${digdir}/definitions/blocks/chat`, 'ola')).status).toBe(404);
    expect(
      (await send(`/tenants/${digdir}/definitions/blocks/chat/versions/1`, 'ola')).status,
    ).toBe(404);
    expect((await send('/definitions/validate', 'ola', { body: block() })).status).toBe(403);
    expect((await publish('ola', block(), 'tar over chat')).status).toBe(403);
  });

  it('refuses on validate, as on publish, a built-in block from anyone but an operator', async () => {
    const { send } = setup();
    const session = await supportSession(send);

    const byMember = await send('/definitions/validate', 'kari', { body: block() });
    const byOperator = await send('/definitions/validate', 'operator', { body: block(), session });

    expect(byMember.status).toBe(403);
    expect(await byMember.json()).toMatchObject({
      type: shareOperatorOnlyType,
      errors: [{ path: 'spec.tier' }],
    });
    expect(byOperator.status).toBe(200);
  });

  it('refuses a code block shared with everyone from anyone but an operator', () => {
    const code = (sharing: string) =>
      block({
        tier: 'code',
        builtIn: undefined,
        sharing,
        code: { sha256: 'a'.repeat(64), bytes: 120, reads: [] },
      });
    const member = principals.kari as NonNullable<typeof principals.kari>;
    const operator = principals.operator as NonNullable<typeof principals.operator>;

    expect(blockPublisherProblems(code('everyone'), member)).toEqual([
      { path: 'spec.sharing', message: expect.stringContaining('kodeblokk') },
    ]);
    expect(blockPublisherProblems(code('organisation'), member)).toEqual([]);
    expect(blockPublisherProblems(code('everyone'), operator)).toEqual([]);
  });

  it('refuses an import with a built-in block from anyone but an operator, and writes nothing', async () => {
    const { send } = setup();
    const bundle = {
      format: 'genai-tenant-export/v1',
      tenant: digdir,
      exportedAt: '2026-10-06T10:00:00.000Z',
      definitions: [{ definition: block(), files: {} }],
      settings: { values: {}, pins: {} },
    };

    const applied = await send(`/tenants/${digdir}/import`, 'kari', {
      body: bundle,
      reason: 'flytter blokker',
    });

    expect(applied.status).toBe(403);
    expect(await applied.json()).toMatchObject({ type: shareOperatorOnlyType });
    expect((await send(`/tenants/${digdir}/definitions/blocks/chat`, 'kari')).status).toBe(404);
  });

  it('exports blocks before services, so an import publishes a block before the service that uses it', async () => {
    const { send } = setup();
    const session = await supportSession(send);
    expect(
      (
        await send('/definitions', 'kari', {
          body: { definition: klarsprak(), files },
          reason: 'første versjon',
        })
      ).status,
    ).toBe(201);
    expect(
      (await publishing(send)('operator', block(), 'genkis chat som blokk', session)).status,
    ).toBe(201);

    const bundle = (await (await send(`/tenants/${digdir}/export`, 'kari')).json()) as {
      definitions: { definition: { kind: string } }[];
    };

    expect(bundle.definitions.map((d) => d.definition.kind)).toEqual(['Block', 'Service']);
  });
});
