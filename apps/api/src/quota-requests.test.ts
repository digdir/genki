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

const boot = async () => {
  const booted = await bootPlatform({ people });
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
