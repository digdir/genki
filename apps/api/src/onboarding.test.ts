import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, readJson as json } from './testkit.js';

const testdep = '405003309';
const nav = '889640782';
const leader = [
  'read',
  'write',
  'use-services',
  'manage-services',
  'manage-datasets',
  'register-building-blocks',
  'view-usage',
];

const people: Record<string, Principal> = {
  ingrid: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ingrid',
    tenant: testdep,
    authorizedFor: [{ org: testdep, actions: leader }],
  },
  bruker: {
    kind: 'employee',
    issuer: 'test',
    subject: 'bruker',
    tenant: testdep,
    authorizedFor: [{ org: testdep, actions: ['read', 'use-services'] }],
  },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: nav,
    authorizedFor: [{ org: nav, actions: leader }],
  },
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const request = (org = testdep, extra: Record<string, unknown> = {}) => ({
  org,
  orgName: org === testdep ? 'Testdepartementet' : 'Arbeids- og velferdsetaten',
  contactName: 'Ingrid Berg',
  contactEmail: 'ingrid@testdep.example.no',
  purpose: 'Vi vil lage en spørsmål-og-svar-tjeneste for veiledere.',
  acceptedTerms: true,
  ...extra,
});

interface OperatorRequest {
  id: string;
  org: string;
  requestedBy: string;
  status: string;
}

describe('self-service onboarding', () => {
  it('shows who sent the request apart from the contact person, and who decided it by name', async () => {
    const { send } = await bootPlatform({ people });

    await send('/onboarding/requests', 'ingrid', {
      body: request(testdep, { contactName: 'Sara Haug' }),
      headers: { 'actor-name': encodeURIComponent('Ingrid Moe') },
    });
    const queue = await json<{ data: OperatorRequest[] }>(
      await send('/operator/onboarding/requests', 'drift'),
    );
    const decided = await send(
      `/operator/onboarding/requests/${queue.data[0]?.id}/decision`,
      'drift',
      {
        body: { approve: true },
        reason: 'Org.nr. er sjekket på brreg.no',
        headers: { 'actor-name': encodeURIComponent('Lise Dahl') },
      },
    );

    expect(queue.data).toEqual([
      expect.objectContaining({ requestedBy: 'Sara Haug', requesterName: 'Ingrid Moe' }),
    ]);
    expect(await decided.json()).toMatchObject({
      decision: { by: 'operator:test:drift', byName: 'Lise Dahl' },
    });
  });

  it('takes an access request from a leader, and the approval lets the organisation in', async () => {
    const { send, admin } = await bootPlatform({ people });

    const before = await send(`/tenants/${testdep}/datasets`, 'ingrid');
    const asked = await send('/onboarding/requests', 'ingrid', { body: request() });
    const created = await json<{ id: string; status: string }>(asked);
    const { id } = created;
    const mine = await json<{ data: { id: string; status: string; terms: unknown }[] }>(
      await send('/onboarding/requests/mine', 'ingrid'),
    );
    const queue = await json<{ data: OperatorRequest[] }>(
      await send('/operator/onboarding/requests?status=pending', 'drift'),
    );
    const decided = await send(`/operator/onboarding/requests/${id}/decision`, 'drift', {
      body: { approve: true },
      reason: 'Avtalen er signert',
    });
    const after = await send(`/tenants/${testdep}/datasets`, 'ingrid');
    const again = await send('/onboarding/requests', 'ingrid', { body: request() });

    expect(before.status).toBe(403);
    expect(asked.status).toBe(201);
    expect(created).toEqual({ id, status: 'pending' });
    expect(mine.data).toEqual([
      expect.objectContaining({
        id,
        status: 'pending',
        terms: expect.objectContaining({ version: 'utkast' }),
      }),
    ]);
    expect(queue.data).toEqual([
      expect.objectContaining({ id, org: testdep, requestedBy: 'Ingrid Berg', status: 'pending' }),
    ]);
    expect(JSON.stringify(queue.data)).not.toContain('employee:test:ingrid');
    expect(decided.status).toBe(200);
    expect(await decided.json()).toMatchObject({
      status: 'approved',
      orgName: 'Testdepartementet',
    });
    expect(after.status).toBe(200);
    expect(again.status).toBe(409);
    expect((await admin.audit()).map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'platform.onboarding.request',
        'platform.tenant.create',
        'platform.onboarding.decide',
      ]),
    );
  });

  it('keeps the organisation name from the login, not the one typed in the form', async () => {
    const named = {
      ...people,
      ingrid: { ...(people.ingrid as Principal), orgNames: { [testdep]: 'Testdepartementet' } },
    };
    const { send } = await bootPlatform({ people: named });

    await send('/onboarding/requests', 'ingrid', {
      body: request(testdep, { orgName: 'Feil navn' }),
    });
    const queue = await json<{ data: { org: string; orgName: string }[] }>(
      await send('/operator/onboarding/requests?status=pending', 'drift'),
    );

    expect(queue.data).toEqual([
      expect.objectContaining({ org: testdep, orgName: 'Testdepartementet' }),
    ]);
  });

  it('records a rejection with its reason and keeps the organisation out', async () => {
    const { send } = await bootPlatform({ people });
    const { id } = await json<{ id: string }>(
      await send('/onboarding/requests', 'erik', { body: request(nav) }),
    );

    const rejected = await send(`/operator/onboarding/requests/${id}/decision`, 'drift', {
      body: { approve: false },
      reason: 'Mangler databehandleravtale',
    });
    const twice = await send(`/operator/onboarding/requests/${id}/decision`, 'drift', {
      body: { approve: true },
      reason: 'Ombestemt meg nå',
    });
    const mine = await json<{ data: { status: string; decision: { reason: string } }[] }>(
      await send('/onboarding/requests/mine', 'erik'),
    );

    expect(rejected.status).toBe(200);
    expect(twice.status).toBe(409);
    expect(mine.data[0]).toMatchObject({
      status: 'rejected',
      decision: { reason: 'Mangler databehandleravtale' },
    });
    expect((await send(`/tenants/${nav}/datasets`, 'erik')).status).toBe(403);
  });

  it('refuses a second pending request and an organisation that is already registered', async () => {
    const { send } = await bootPlatform({ people });
    await send('/onboarding/requests', 'ingrid', { body: request() });

    const pending = await send('/onboarding/requests', 'ingrid', { body: request() });
    const registered = await send('/onboarding/requests', 'kari', { body: request(digdir) });

    expect(pending.status).toBe(409);
    expect(registered.status).toBe(409);
  });

  it('needs a leader of the organisation, valid fields and accepted terms', async () => {
    const { send } = await bootPlatform({ people });

    expect((await send('/onboarding/requests', 'bruker', { body: request() })).status).toBe(403);
    expect((await send('/onboarding/requests', 'erik', { body: request() })).status).toBe(403);
    expect(
      (
        await send('/onboarding/requests', 'ingrid', {
          body: request(testdep, { acceptedTerms: false }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await send('/onboarding/requests', 'ingrid', { body: request('123456789') })).status,
    ).toBe(400);
    expect(
      (
        await send('/onboarding/requests', 'ingrid', {
          body: request(testdep, { contactEmail: 'nei' }),
        })
      ).status,
    ).toBe(400);
  });

  it('tells someone acting for the organisation whether it is registered, asked for, and whether they may ask', async () => {
    const per = { ...people.ingrid, subject: 'per' } as Principal;
    const { send } = await bootPlatform({ people: { ...people, per } });
    const status = async (who: string, org = testdep) =>
      json<unknown>(await send(`/onboarding/organisations/${org}`, who));

    const before = await status('ingrid');
    await send('/onboarding/requests', 'ingrid', { body: request() });

    expect(before).toEqual({
      org: testdep,
      registered: false,
      mayRequest: true,
      pendingRequest: null,
    });
    expect(await status('ingrid')).toEqual(
      expect.objectContaining({
        pendingRequest: { requestedAt: expect.any(String), mine: true },
      }),
    );
    expect(await status('per')).toEqual(
      expect.objectContaining({
        pendingRequest: { requestedAt: expect.any(String), mine: false },
      }),
    );
    expect(await status('bruker')).toEqual(expect.objectContaining({ mayRequest: false }));
    expect(await status('kari', digdir)).toEqual(expect.objectContaining({ registered: true }));
    expect((await send(`/onboarding/organisations/${testdep}`, 'erik')).status).toBe(403);
  });

  it('keeps the queue and decisions for operators', async () => {
    const { send } = await bootPlatform({ people });
    const { id } = await json<{ id: string }>(
      await send('/onboarding/requests', 'ingrid', { body: request() }),
    );

    expect((await send('/operator/onboarding/requests', 'kari')).status).toBe(403);
    expect(
      (
        await send(`/operator/onboarding/requests/${id}/decision`, 'ingrid', {
          body: { approve: true },
          reason: 'Godkjenner meg selv',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await send(`/operator/onboarding/requests/${id}/decision`, 'drift', {
          body: { approve: true },
        })
      ).status,
    ).toBe(400);
  });

  it('an operator decision takes its reason from the change-reason header, never from the body', async () => {
    const { send } = await bootPlatform({ people });
    const { id } = await json<{ id: string }>(
      await send('/onboarding/requests', 'ingrid', { body: request() }),
    );

    const bodyOnly = await send(`/operator/onboarding/requests/${id}/decision`, 'drift', {
      body: { approve: true, reason: 'Begrunnelse bare i kroppen' },
    });
    const decided = await send(`/operator/onboarding/requests/${id}/decision`, 'drift', {
      body: { approve: true, reason: 'Teksten i kroppen brukes ikke' },
      reason: 'Begrunnelse i overskriften',
    });

    expect(bodyOnly.status).toBe(400);
    expect(await bodyOnly.json()).toMatchObject({ errors: [{ path: 'change-reason' }] });
    expect(await decided.json()).toMatchObject({
      decision: { reason: 'Begrunnelse i overskriften' },
    });
  });
});
