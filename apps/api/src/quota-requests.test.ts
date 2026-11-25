import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, readJson } from './testkit.js';

const other = '889640782';

const member = (subject: string, tenant: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant,
  authorizedFor: [{ org: tenant, actions }],
});

const people: Record<string, Principal> = {
  kari: member('kari', digdir, ['manage-services', 'view-usage']),
  per: member('per', digdir, ['use-services']),
  ola: member('ola', other, ['manage-services', 'view-usage']),
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

interface Request {
  id: string;
  monthlyTokens: number;
  reason: string;
  state: string;
  tenant?: string;
}

const boot = async (services: string[] = []) => {
  const booted = await bootPlatform({ people, services });
  await booted.platform.directory.add(
    { orgNumber: other, name: 'Testetaten', status: 'active' },
    'test',
  );
  const ask = (tenant: string, who: string, monthlyTokens = 80_000_000) =>
    booted.send(`/tenants/${tenant}/quota-requests`, who, {
      body: { monthlyTokens },
      reason: 'Flere tjenester i drift fra desember',
    });
  const decide = (
    tenant: string,
    id: string,
    decision: string,
    reason = 'Godkjent etter samtale',
  ) =>
    booted.send(`/operator/quota-requests/${tenant}/${id}/decision`, 'drift', {
      body: { decision },
      reason,
    });
  return { ...booted, ask, decide };
};

describe('quota requests', () => {
  it('stores a request with its amount and reason, and records it in the audit log', async () => {
    const { ask, send, admin } = await boot();

    const asked = await ask(digdir, 'kari');
    const listed = await readJson<{ data: Request[] }>(
      await send(`/tenants/${digdir}/quota-requests`, 'kari'),
    );

    expect(asked.status).toBe(201);
    expect(listed.data).toMatchObject([
      {
        monthlyTokens: 80_000_000,
        reason: 'Flere tjenester i drift fra desember',
        state: 'pending',
      },
    ]);
    expect((await admin.audit(digdir)).map((e) => [e.action, e.outcome])).toContainEqual([
      'platform.quota.request',
      'applied',
    ]);
  });

  it('refuses a request without manage-services, and the list without view-usage', async () => {
    const { ask, send } = await boot();

    expect((await ask(digdir, 'per')).status).toBe(403);
    expect((await send(`/tenants/${digdir}/quota-requests`, 'per')).status).toBe(403);
  });

  it('refuses a second request while one waits for a decision', async () => {
    const { ask } = await boot();
    await ask(digdir, 'kari');

    const again = await ask(digdir, 'kari');

    expect(again.status).toBe(409);
    expect(await readJson(again)).toMatchObject({
      type: 'urn:genai:problem:quota-request-pending',
    });
  });

  it("keeps a tenant's requests away from other tenants", async () => {
    const { ask, send } = await boot();
    await ask(digdir, 'kari');

    expect((await send(`/tenants/${digdir}/quota-requests`, 'ola')).status).toBe(404);
    expect(
      (await readJson<{ data: Request[] }>(await send(`/tenants/${other}/quota-requests`, 'ola')))
        .data,
    ).toEqual([]);
  });

  it('lets an operator see every request and decide one once, with the decision audited', async () => {
    const { ask, decide, send, admin } = await boot();
    const { id } = await readJson<Request>(await ask(digdir, 'kari'));

    const queue = await readJson<{ data: Request[] }>(
      await send('/operator/quota-requests?state=pending', 'drift'),
    );
    const decided = await decide(digdir, id, 'approved');
    const again = await decide(digdir, id, 'rejected');

    expect(queue.data).toMatchObject([{ id, tenant: digdir }]);
    expect(decided.status).toBe(200);
    expect(await readJson(decided)).toMatchObject({ state: 'approved' });
    expect(again.status).toBe(409);
    expect(await readJson(again)).toMatchObject({
      type: 'urn:genai:problem:quota-request-decided',
    });
    expect((await admin.audit()).map((e) => [e.action, e.outcome])).toContainEqual([
      'platform.quota.decide',
      'applied',
    ]);
  });

  it("raises the organisation's monthly tokens when an operator approves a quota request", async () => {
    const { ask, decide, settings, admin } = await boot();
    const { id } = await readJson<Request>(await ask(digdir, 'kari', 80_000_000));

    await decide(digdir, id, 'approved', 'Godkjent etter samtale');

    expect(settings.tenant(digdir).values['usage.monthlyTokens']).toBe(80_000_000);
    expect(
      (await admin.audit(digdir))
        .filter((e) => e.action === 'platform.setting.set')
        .map((e) => [e.outcome, e.target, e.reason, e.actor]),
    ).toEqual([
      ['applied', 'setting:usage.monthlyTokens', 'Godkjent etter samtale', 'operator:test:drift'],
    ]);
  });

  it('leaves the quota unchanged when a request is rejected', async () => {
    const { ask, decide, settings, admin } = await boot();
    const { id } = await readJson<Request>(await ask(digdir, 'kari', 80_000_000));

    const rejected = await decide(digdir, id, 'rejected', 'Ikke nå, ta det opp i januar');

    expect(await readJson(rejected)).toMatchObject({ state: 'rejected' });
    expect(settings.tenant(digdir).values['usage.monthlyTokens']).toBeUndefined();
    expect((await admin.audit(digdir)).map((e) => e.action)).not.toContain('platform.setting.set');
  });

  it('lets no organisation admin raise its own quota by deciding its own request', async () => {
    const { ask, send, settings } = await boot();
    const { id } = await readJson<Request>(await ask(digdir, 'kari', 80_000_000));

    const decided = await send(`/operator/quota-requests/${digdir}/${id}/decision`, 'kari', {
      body: { decision: 'approved' },
      reason: 'Godkjenner selv',
    });

    expect(decided.status).toBe(403);
    expect(settings.tenant(digdir).values['usage.monthlyTokens']).toBeUndefined();
  });

  it("shows operators each organisation's use this month against its current quota", async () => {
    const { ask, send } = await boot();
    await ask(digdir, 'kari', 80_000_000);

    const queue = await readJson<{ data: (Request & { quota?: unknown })[] }>(
      await send('/operator/quota-requests', 'drift'),
    );

    expect(queue.data).toMatchObject([
      { tenant: digdir, quota: { usedTokens: 0, monthlyTokens: 50_000_000 } },
    ]);
  });

  it("lists each organisation's quota and its tokens this month on the operator tenant list, as quota enforcement counts them", async () => {
    const { ask, decide, send, platform } = await boot(['skrivehjelp']);
    const { id } = await readJson<Request>(await ask(digdir, 'kari', 80_000_000));
    await decide(digdir, id, 'approved');

    const tenants = await readJson<{
      data: { orgNumber: string; usedTokens?: number; monthlyTokens?: number }[];
    }>(await send('/operator/tenants', 'drift'));
    const enforced = await platform.quota(digdir);

    expect(tenants.data.find((t) => t.orgNumber === digdir)).toMatchObject({
      usedTokens: enforced.usedTokens,
      monthlyTokens: 80_000_000,
    });
  });

  it('says in bokmål that a decided request is already approved', async () => {
    const { ask, decide, send } = await boot();
    const { id } = await readJson<Request>(await ask(digdir, 'kari'));
    await decide(digdir, id, 'approved');

    const again = await send(`/operator/quota-requests/${digdir}/${id}/decision`, 'drift', {
      body: { decision: 'rejected' },
      reason: 'Avslått likevel',
      headers: { 'accept-language': 'nb' },
    });

    expect(await readJson(again)).toMatchObject({
      errors: [{ path: 'state', message: 'forespørselen om kvote er allerede godkjent' }],
    });
  });

  it('refuses an unknown state filter on the operator list', async () => {
    const { send } = await boot();

    expect((await send('/operator/quota-requests?state=maybe', 'drift')).status).toBe(400);
    expect((await send('/operator/quota-requests?state=pending', 'drift')).status).toBe(200);
  });

  it('lets only operators see and decide quota requests', async () => {
    const { ask, send } = await boot();
    const { id } = await readJson<Request>(await ask(digdir, 'kari'));

    expect((await send('/operator/quota-requests', 'kari')).status).toBe(403);
    expect(
      (
        await send(`/operator/quota-requests/${digdir}/${id}/decision`, 'kari', {
          body: { decision: 'approved' },
          reason: 'Godkjenner selv',
        })
      ).status,
    ).toBe(403);
  });

  it('refuses a decision without a change reason or with an unknown decision', async () => {
    const { ask, decide } = await boot();
    const { id } = await readJson<Request>(await ask(digdir, 'kari'));

    expect((await decide(digdir, id, 'approved', 'kort')).status).toBe(400);
    expect((await decide(digdir, id, 'maybe')).status).toBe(400);
  });

  it('refuses a request for zero or a fraction of tokens', async () => {
    const { ask } = await boot();

    expect((await ask(digdir, 'kari', 0)).status).toBe(400);
    expect((await ask(digdir, 'kari', 1.5)).status).toBe(400);
  });
});
