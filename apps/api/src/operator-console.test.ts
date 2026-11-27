import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, readJson } from './testkit.js';

const other = '889640782';
const testdep = '405003309';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['manage-services', 'view-usage'] }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: other,
    authorizedFor: [{ org: other, actions: ['manage-services', 'view-usage'] }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
  ingrid: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ingrid',
    tenant: testdep,
    authorizedFor: [{ org: testdep, actions: ['manage-services'] }],
  },
};

const clock = Date.parse('2026-11-26T10:00:00Z');
const soon = '2026-11-30T23:00:00Z';

interface Item {
  type: string;
  id: string;
  tenant: string | null;
  blocks: boolean;
  due?: string;
  action: { method: string; path: string };
}

interface Entry {
  action: string;
  actor: string;
  reason: string;
  tenant: string;
}

const boot = async () => {
  const booted = await bootPlatform({ people, now: () => clock });
  await booted.platform.directory.add(
    { orgNumber: other, name: 'Testetaten', status: 'active' },
    'test',
  );
  const ask = () =>
    booted.send(`/tenants/${other}/quota-requests`, 'ola', {
      body: { monthlyTokens: 60_000_000 },
      reason: 'Flere tjenester i drift fra desember',
    });
  const decide = (id: string, body: unknown, reason = 'Venter på budsjettet for neste år') =>
    booted.send(`/operator/quota-requests/${other}/${id}/decision`, 'drift', { body, reason });
  const flag = (tenant: string, body: Record<string, unknown>, reason = 'Pilot for utforming') =>
    booted.send('/operator/flags/blockStudio', 'drift', {
      method: 'PUT',
      body: { tenant, ...body },
      reason,
    });
  const inbox = async (query = '') =>
    (await readJson<{ data: Item[] }>(await booted.send(`/operator/inbox${query}`, 'drift'))).data;
  return { ...booted, ask, decide, flag, inbox };
};

describe('operator inbox', () => {
  it('lists quota requests, incidents and expiring flag overrides in one list, expiring ones last', async () => {
    const { ask, flag, send, inbox } = await boot();
    await flag(other, { on: true, expiresAt: soon });
    const { id } = await readJson<{ id: string }>(await ask());
    await send('/operator/incidents', 'drift', {
      body: { title: 'Borealis svarer tregt', text: 'Vi undersøker', tenants: [other] },
      reason: 'Overvåkingen varslet tregt svar',
    });

    const items = await inbox();

    expect(items.map((i) => i.type).sort()).toEqual(['expiring', 'incident', 'quota']);
    expect(items.at(-1)).toMatchObject({ type: 'expiring', tenant: other, due: soon });
    expect(items.find((i) => i.type === 'quota')).toMatchObject({
      id,
      tenant: other,
      tenantName: 'Testetaten',
      blocks: false,
      action: { method: 'POST', path: `/operator/quota-requests/${other}/${id}/decision` },
    });
  });

  it('lists an access request as blocking', async () => {
    const { send, inbox } = await boot();
    await send('/onboarding/requests', 'ingrid', {
      body: {
        org: testdep,
        orgName: 'Testdepartementet',
        contactName: 'Ingrid Berg',
        contactEmail: 'ingrid@testdep.example.no',
        purpose: 'Vi vil lage en spørsmål-og-svar-tjeneste for veiledere.',
        acceptedTerms: true,
      },
    });

    expect(await inbox('?type=access')).toMatchObject([{ type: 'access', blocks: true }]);
  });

  it('shows an incident for several tenants under each of them, and not under others', async () => {
    const { send, inbox } = await boot();
    await send('/operator/incidents', 'drift', {
      body: { title: 'Borealis svarer tregt', text: 'Vi undersøker', tenants: [other, testdep] },
      reason: 'Overvåkingen varslet tregt svar',
    });

    expect(await inbox(`?tenant=${other}`)).toMatchObject([{ type: 'incident', tenant: null }]);
    expect(await inbox(`?tenant=${digdir}`)).toEqual([]);
  });

  it('keeps one tenant out of the list filtered to another', async () => {
    const { ask, inbox } = await boot();
    await ask();

    expect(await inbox(`?tenant=${digdir}`)).toEqual([]);
  });

  it('leaves out a flag override that expires more than seven days ahead', async () => {
    const { flag, inbox } = await boot();
    await flag(other, { on: true, expiresAt: '2026-12-31T23:00:00Z' });

    expect(await inbox('?type=expiring')).toEqual([]);
  });

  it('refuses the inbox to everyone but operators, and an unknown type', async () => {
    const { send } = await boot();

    expect((await send('/operator/inbox', 'kari')).status).toBe(403);
    expect((await send('/operator/inbox', 'nobody')).status).toBe(401);
    expect((await send('/operator/inbox?type=other', 'drift')).status).toBe(400);
  });

  it('counts what waits per tenant in the operator tenant list', async () => {
    const { ask, send } = await boot();
    await ask();

    const tenants = await readJson<{ data: { orgNumber: string; waiting?: unknown }[] }>(
      await send('/operator/tenants', 'drift'),
    );

    expect(tenants.data.find((t) => t.orgNumber === other)?.waiting).toEqual({
      count: 1,
      blocks: false,
      types: ['quota'],
    });
    expect(tenants.data.find((t) => t.orgNumber === digdir)?.waiting).toBeUndefined();
  });
});

describe('postponing a quota request', () => {
  it("takes the request out of the inbox until the date, keeps it from the tenant, and audits it in the platform's log only", async () => {
    const { ask, decide, send, inbox, admin } = await boot();
    const { id } = await readJson<{ id: string }>(await ask());

    const postponed = await decide(id, {
      decision: 'postponed',
      until: '2026-11-27',
      note: 'Spør igjen etter nyttår',
    });
    const own = await readJson<{ data: Record<string, unknown>[] }>(
      await send(`/tenants/${other}/quota-requests`, 'ola'),
    );

    expect(postponed.status).toBe(200);
    expect(await inbox('?type=quota')).toEqual([]);
    expect(own.data[0]).toMatchObject({ id, state: 'pending' });
    expect(own.data[0]).not.toHaveProperty('postponed');
    expect((await admin.audit(other)).map((e) => e.action)).not.toContain(
      'platform.quota.postpone',
    );
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({
        action: 'platform.quota.postpone',
        reason: 'Venter på budsjettet for neste år',
        outcome: 'applied',
      }),
    );
  });

  it('refuses to postpone to today or earlier', async () => {
    const { ask, decide } = await boot();
    const { id } = await readJson<{ id: string }>(await ask());

    expect((await decide(id, { decision: 'postponed', until: '2026-11-26' })).status).toBe(400);
  });

  it('still lets an operator approve a postponed request', async () => {
    const { ask, decide, platform } = await boot();
    const { id } = await readJson<{ id: string }>(await ask());
    await decide(id, { decision: 'postponed', until: '2026-12-01' });

    const approved = await decide(id, { decision: 'approved' }, 'Budsjettet kom tidligere');

    expect(approved.status).toBe(200);
    expect((await platform.quota(other)).monthlyTokens).toBe(60_000_000);
  });

  it('sets the quota the operator chose when approving, and shows the tenant that amount', async () => {
    const { ask, decide, platform, send } = await boot();
    const { id } = await readJson<{ id: string }>(await ask());

    const approved = await decide(
      id,
      { decision: 'approved', monthlyTokens: 70_000_000 },
      'Godkjent med litt mer enn bedt om',
    );

    const own = await readJson<{ data: { decision?: { monthlyTokens?: number } }[] }>(
      await send(`/tenants/${other}/quota-requests`, 'ola'),
    );

    expect(approved.status).toBe(200);
    expect((await platform.quota(other)).monthlyTokens).toBe(70_000_000);
    expect(own.data[0]?.decision?.monthlyTokens).toBe(70_000_000);
  });

  it('refuses a decision from anyone but an operator', async () => {
    const { ask, send } = await boot();
    const { id } = await readJson<{ id: string }>(await ask());

    const refused = await send(`/operator/quota-requests/${other}/${id}/decision`, 'ola', {
      body: { decision: 'postponed', until: '2026-12-01' },
      reason: 'Prøver å utsette min egen',
    });

    expect(refused.status).toBe(403);
  });
});

describe('flags per organisation', () => {
  it("shows one organisation's flag choices with who set them and when they expire, and no other organisation's", async () => {
    const { flag, send } = await boot();
    await flag(other, { on: true, expiresAt: soon });
    await flag(digdir, { on: false }, 'Av for Digdir i pilotperioden');

    const body = await readJson<{
      data: { key: string; on: boolean; owner: string; tenant: unknown; people: unknown[] }[];
    }>(await send(`/operator/tenants/${other}/flags`, 'drift'));

    expect(body.data).toMatchObject([
      {
        key: 'blockStudio',
        on: true,
        owner: 'the lab',
        tenant: {
          on: true,
          by: 'operator:test:drift',
          reason: 'Pilot for utforming',
          expiresAt: soon,
          expired: false,
        },
        people: [],
      },
    ]);
  });

  it("audits an override with its reason in the organisation's own log, on its behalf", async () => {
    const { flag, admin } = await boot();

    await flag(other, { on: true, expiresAt: soon });

    expect(await admin.audit(other)).toContainEqual(
      expect.objectContaining({
        action: 'platform.flag.tenant',
        actor: 'operator:test:drift',
        onBehalfOf: other,
        reason: 'Pilot for utforming',
      }),
    );
  });

  it('marks an override in the flag list with its expiry', async () => {
    const { flag, send } = await boot();
    await flag(other, { on: true, expiresAt: soon });

    const body = await readJson<{ data: { rows: unknown[] }[] }>(
      await send('/operator/flags', 'drift'),
    );

    expect(body.data[0]?.rows).toMatchObject([{ tenant: other, expiresAt: soon, expired: false }]);
  });

  it('refuses an expiry in the past, and an expiry on a cleared choice', async () => {
    const { flag } = await boot();

    expect((await flag(other, { on: true, expiresAt: '2026-11-01T00:00:00Z' })).status).toBe(400);
    expect((await flag(other, { on: null, expiresAt: soon })).status).toBe(400);
  });

  it('refuses the per-organisation flags and hostnames to everyone but operators', async () => {
    const { send } = await boot();

    for (const path of [`/operator/tenants/${other}/flags`, `/operator/tenants/${other}/hostnames`])
      expect((await send(path, 'ola')).status).toBe(403);
    expect(await readJson(await send(`/operator/tenants/${other}/hostnames`, 'drift'))).toEqual({
      data: [],
    });
  });
});

describe('audit filters', () => {
  it("narrows a tenant's log by who, action and period, and counts what is kept", async () => {
    const { ask, flag, send } = await boot();
    await ask();
    await flag(other, { on: true });

    const read = async (query: string) =>
      readJson<{ data: Entry[]; total: number }>(
        await send(`/tenants/${other}/audit?${query}`, 'ola'),
      );

    expect((await read('by=operator')).data.map((e) => e.action)).toEqual(['platform.flag.tenant']);
    expect((await read('by=tenant')).data.map((e) => e.action)).toEqual(['platform.quota.request']);
    expect(await read('action=platform.quota&limit=10')).toMatchObject({ total: 1 });
    expect((await read('actor=operator:test:drift')).data).toHaveLength(1);
    expect((await read('from=2026-11-26')).total).toBe(2);
    expect((await read('to=2026-11-25')).total).toBe(0);
  });

  it('narrows the whole log to one tenant and action for an operator, and refuses a bad filter', async () => {
    const { ask, flag, send } = await boot();
    await ask();
    await flag(digdir, { on: true });

    const body = await readJson<{ data: Entry[]; total: number }>(
      await send(`/operator/audit?tenant=${other}&action=platform.quota`, 'drift'),
    );

    const page = await readJson<{ data: Entry[]; total: number }>(
      await send('/operator/audit?limit=1', 'drift'),
    );

    expect(body.data.map((e) => [e.tenant, e.action])).toEqual([[other, 'platform.quota.request']]);
    expect(page.data).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
    expect((await send('/operator/audit?by=everyone', 'drift')).status).toBe(400);
    expect((await send('/operator/audit', 'ola')).status).toBe(403);
  });

  it("keeps another tenant's log closed whatever the filter", async () => {
    const { send } = await boot();

    expect((await send(`/tenants/${digdir}/audit?by=operator`, 'ola')).status).toBe(404);
  });
});

describe('the operator overview and content', () => {
  it("shows an operator an organisation's overview and still asks for the day's reason before its runs", async () => {
    const { ask, send } = await boot();
    await ask();

    const overview = await send(`/operator/tenants/${other}`, 'drift');
    const runs = await send(`/tenants/${other}/tasks`, 'drift');

    expect(overview.status).toBe(200);
    expect(await readJson(overview)).toMatchObject({
      name: 'Testetaten',
      needsAction: [{ type: 'quota', tenant: other }],
    });
    expect(runs.status).toBe(403);
    expect(await readJson(runs)).toMatchObject({
      type: 'urn:genai:problem:content-reason-required',
    });
  });
});
