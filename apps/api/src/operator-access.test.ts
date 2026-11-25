import { platformSettings } from '@genai/definitions';
import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { tenantAccess } from './access.js';
import { contentReasonRequiredType } from './content-reason.js';
import { bootPlatform, digdir, other, principals, setup } from './testkit.js';

type Entry = { action: string; actor: string; onBehalfOf?: string; reason: string };

const timeline = `/tenants/${other}/tasks/no-such-task/timeline`;
const reasonPath = (tenant: string) => `/operator/tenants/${tenant}/content-reason`;

const giveReason = (send: ReturnType<typeof setup>['send'], tenant = other, who = 'operator') =>
  send(reasonPath(tenant), who, { body: { reason: 'Saken om feil svar i KA-12' } });

const auditOf = async (send: ReturnType<typeof setup>['send']) =>
  ((await (await send(`/tenants/${other}/audit`, 'ola')).json()) as { data: Entry[] }).data;

describe('operators own the platform', () => {
  it("lets an operator raise an organisation's monthly tokens without a support session, with a change reason", async () => {
    const { send } = setup({ settings: platformSettings });

    const set = await send(`/tenants/${other}/settings/usage.monthlyTokens`, 'operator', {
      method: 'PUT',
      body: { value: 5_000_000 },
      reason: 'Ny avtale om forbruk',
    });

    expect(set.status).toBe(200);
    const effective = (await (
      await send(`/tenants/${other}/settings/effective`, 'ola')
    ).json()) as Record<string, unknown>;
    expect(effective['usage.monthlyTokens']).toMatchObject({ value: 5_000_000, source: 'tenant' });
  });

  it("refuses an operator's change to an organisation without a change reason", async () => {
    const { send } = setup({ settings: platformSettings });

    const set = await send(`/tenants/${other}/settings/usage.monthlyTokens`, 'operator', {
      method: 'PUT',
      body: { value: 5_000_000 },
    });

    expect(set.status).toBe(400);
  });

  it("shows an operator's change in the organisation's own log", async () => {
    const { send } = setup({ settings: platformSettings });
    await send(`/tenants/${other}/settings/usage.monthlyTokens`, 'operator', {
      method: 'PUT',
      body: { value: 5_000_000 },
      reason: 'Ny avtale om forbruk',
    });

    expect(await auditOf(send)).toContainEqual(
      expect.objectContaining({
        action: 'platform.setting.set',
        actor: 'operator:test:drift',
        onBehalfOf: other,
        reason: 'Ny avtale om forbruk',
      }),
    );
  });

  it("never gives an operator a tenant's own rights outside lockdown", () => {
    const acting = tenantAccess(
      principals.operator as Principal,
      other,
      new Request('http://localhost/'),
    );

    expect(acting?.kind).toBe('operator');
    expect(acting?.actor).toEqual(principals.operator);
    expect(acting?.authorizedFor?.some((a) => a.org === other) ?? false).toBe(false);
  });
});

describe('the daily content reason', () => {
  it("refuses an operator's content read until a reason is given for that organisation today", async () => {
    const { send } = setup();

    const before = await send(timeline, 'operator');
    expect(before.status).toBe(403);
    expect(await before.json()).toMatchObject({ type: contentReasonRequiredType, tenant: other });

    expect((await giveReason(send)).status).toBe(201);
    expect((await send(timeline, 'operator')).status).not.toBe(403);
    expect((await send(timeline, 'other-operator')).status).toBe(403);
    expect((await send(`/tenants/${digdir}/tasks/no-such-task/timeline`, 'operator')).status).toBe(
      403,
    );
  });

  it("refuses an operator a skill's definition and the organisation's export until a reason is given, and shows other definitions directly", async () => {
    const { send } = setup();
    const typeOf = async (path: string) =>
      ((await (await send(path, 'operator')).json()) as { type?: string }).type;
    const refused = [
      `/tenants/${other}/definitions/skills/svar`,
      `/tenants/${other}/definitions/skills/svar/versions/1`,
      `/tenants/${other}/export`,
    ];
    const direct = [`/tenants/${other}/definitions/services/svar`];

    for (const path of refused) expect(await typeOf(path), path).toBe(contentReasonRequiredType);
    for (const path of direct) expect(await typeOf(path), path).not.toBe(contentReasonRequiredType);
    await giveReason(send);
    for (const path of refused)
      expect(await typeOf(path), path).not.toBe(contentReasonRequiredType);
  });

  it("refuses an operator a skill's definition on the operator routes until a reason is given", async () => {
    const { send } = await bootPlatform({ people: { drift: principals.operator as Principal } });
    const typeOf = async (path: string) =>
      ((await (await send(path, 'drift')).json()) as { type?: string }).type;
    const skill = `/operator/tenants/${other}/definitions/skills/svar`;

    expect(await typeOf(skill)).toBe(contentReasonRequiredType);
    expect(await typeOf(`${skill}/versions/1`)).toBe(contentReasonRequiredType);
    expect(await typeOf(`/operator/tenants/${other}/definitions/services/svar`)).not.toBe(
      contentReasonRequiredType,
    );
    expect(await typeOf(`/operator/tenants/${other}/definitions`)).not.toBe(
      contentReasonRequiredType,
    );
    await send(reasonPath(other), 'drift', { body: { reason: 'Saken om feil svar i KA-12' } });
    expect(await typeOf(skill)).not.toBe(contentReasonRequiredType);
  });

  it("refuses an operator a skill's copy, change, fix, import and run estimates, which return content, until a reason is given", async () => {
    const { send } = await bootPlatform({ people: { drift: principals.operator as Principal } });
    const typeOf = async (path: string, method: string) =>
      (
        (await (
          await send(path, 'drift', { method, body: {}, reason: 'Feilsøking av en sak' })
        ).json()) as { type?: string }
      ).type;

    for (const [method, path] of [
      ['POST', `/tenants/${other}/skills/svar/copy`],
      ['PUT', `/tenants/${other}/skills/svar`],
      ['POST', `/tenants/${other}/skills/svar/fix/f1/apply`],
      ['POST', `/tenants/${other}/skills/import`],
      ['POST', `/tenants/${other}/services/svar/batch-runs/estimate`],
      ['POST', `/tenants/${other}/projects/p1/runs/estimate`],
    ] as const)
      expect(await typeOf(path, method), path).toBe(contentReasonRequiredType);
  });

  it("refuses an operator the input fields of an organisation's definition, which list its datasets' values, until a reason is given", async () => {
    const { send } = await bootPlatform({ people: { drift: principals.operator as Principal } });

    const refused = await send(`/tenants/${other}/definitions/input-fields`, 'drift', {
      body: {},
      reason: 'Feilsøking av en sak',
    });

    expect(((await refused.json()) as { type?: string }).type).toBe(contentReasonRequiredType);
  });

  it('refuses an operator a HEAD request on content as it refuses a GET', async () => {
    const { app } = setup();

    const head = await app.request(timeline, {
      method: 'HEAD',
      headers: { authorization: 'Bearer operator' },
    });

    expect(head.status).toBe(403);
  });

  it("shows each content read in the organisation's own log with the reason", async () => {
    const { send } = setup();
    await giveReason(send);
    await send(timeline, 'operator');
    await send(timeline, 'operator');

    const reads = (await auditOf(send)).filter((e) => e.action === 'platform.content.read');
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({
      actor: 'operator:test:drift',
      onBehalfOf: other,
      reason: 'Saken om feil svar i KA-12',
    });
  });

  it('keeps the content reason for the rest of the Oslo day and asks again the next day', async () => {
    const { send, advance } = setup();
    await giveReason(send);

    advance(11 * 60 + 59);
    expect((await send(timeline, 'operator')).status).not.toBe(403);

    advance(2);
    expect((await send(timeline, 'operator')).status).toBe(403);
  });

  it('answers with the Oslo day the reason holds for', async () => {
    const { send } = setup();

    expect(await (await giveReason(send)).json()).toMatchObject({
      tenant: other,
      day: '2026-10-06',
      expiresAt: '2026-10-06T22:00:00.000Z',
    });
  });

  it('refuses a content reason from anyone who is not an operator', async () => {
    const { send } = setup();

    expect((await giveReason(send, other, 'ola')).status).toBe(403);
  });

  it('refuses a content reason that is too short', async () => {
    const { send } = setup();

    const given = await send(reasonPath(other), 'operator', { body: { reason: 'kort' } });

    expect(given.status).toBe(400);
  });

  it('lets an operator with Altinn rights in an organisation read its content as a member without a reason', async () => {
    const { send } = setup();

    expect((await send(timeline, 'operator-employed-at-other')).status).not.toBe(403);
  });

  it("leaves an organisation's own people reading their content without a reason", async () => {
    const { send } = setup();

    expect((await send(timeline, 'ola')).status).not.toBe(403);
  });
});
