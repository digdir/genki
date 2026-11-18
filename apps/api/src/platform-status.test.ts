import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { bootPlatform, digdir, readJson } from './testkit.js';

const other = '889640782';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

interface Incident {
  id: string;
  title: string;
  tenants: string[];
  resolvedAt?: string;
}

const boot = async () => {
  const booted = await bootPlatform({ people });
  await booted.platform.directory.add(
    { orgNumber: other, name: 'Testetaten', status: 'active' },
    'test',
  );
  const write = (title: string, tenants?: string[], reason = 'Kunder melder om feil') =>
    booted.send('/operator/incidents', 'drift', {
      body: { title, text: `${title} i dag`, ...(tenants ? { tenants } : {}) },
      reason,
    });
  const titlesFor = async (tenant: string, who: string) =>
    (
      await readJson<{ incidents: { title: string }[] }>(
        await booted.send(`/tenants/${tenant}/status`, who),
      )
    ).incidents
      .map((i) => i.title)
      .sort();
  return { ...booted, write, titlesFor };
};

describe('platform status for tenants', () => {
  it('shows a tenant the open incidents for everyone and for it, never those only for another tenant', async () => {
    const { write, titlesFor } = await boot();
    await write('Treg modell');
    await write('Innlesing stopper', [digdir]);
    await write('Nøkkel utløpt', [other]);

    expect(await titlesFor(digdir, 'kari')).toEqual(['Innlesing stopper', 'Treg modell'].sort());
    expect(await titlesFor(other, 'ola')).toEqual(['Nøkkel utløpt', 'Treg modell'].sort());
  });

  it('never tells a tenant which other tenants an incident concerns', async () => {
    const { write, send } = await boot();
    await write('Innlesing stopper', [digdir, other]);

    expect(
      JSON.stringify(await readJson(await send(`/tenants/${digdir}/status`, 'kari'))),
    ).not.toContain(other);
  });

  it('stops showing an incident once an operator resolves it, and audits both steps', async () => {
    const { write, send, titlesFor, admin } = await boot();
    const { id } = await readJson<Incident>(await write('Treg modell'));

    const resolved = await send(`/operator/incidents/${id}/resolve`, 'drift', {
      method: 'POST',
      reason: 'Leverandøren har rettet feilen',
    });
    const again = await send(`/operator/incidents/${id}/resolve`, 'drift', {
      method: 'POST',
      reason: 'Leverandøren har rettet feilen',
    });

    expect(resolved.status).toBe(200);
    expect(again.status).toBe(409);
    expect(await readJson(again)).toMatchObject({ type: 'urn:genai:problem:incident-resolved' });
    expect(await titlesFor(digdir, 'kari')).toEqual([]);
    expect((await admin.audit()).map((e) => e.action)).toEqual(
      expect.arrayContaining(['platform.incident.save', 'platform.incident.resolve']),
    );
  });

  it('shows the open incidents in the operator overview', async () => {
    const { write, send } = await boot();
    await write('Treg modell');

    const overview = await readJson<{ incidents: { title: string }[] }>(
      await send('/operator/operations', 'drift'),
    );

    expect(overview.incidents.map((i) => i.title)).toEqual(['Treg modell']);
  });

  it('lets only operators write, list and resolve incidents', async () => {
    const { write, send } = await boot();
    const { id } = await readJson<Incident>(await write('Treg modell'));

    const tenantWrite = await send('/operator/incidents', 'kari', {
      body: { title: 'Falsk', text: 'Falsk hendelse' },
      reason: 'Prøver å skrive selv',
    });

    expect(tenantWrite.status).toBe(403);
    expect((await send('/operator/incidents', 'kari')).status).toBe(403);
    expect(
      (
        await send(`/operator/incidents/${id}/resolve`, 'kari', {
          method: 'POST',
          reason: 'Prøver å løse selv',
        })
      ).status,
    ).toBe(403);
  });

  it('refuses an incident without a change reason, title or text', async () => {
    const { write, send } = await boot();

    expect((await write('Treg modell', undefined, 'kort')).status).toBe(400);
    expect(
      (
        await send('/operator/incidents', 'drift', {
          body: { title: '' },
          reason: 'Kunder melder om feil',
        })
      ).status,
    ).toBe(400);
  });

  it("answers 404 for another tenant's status", async () => {
    const { send } = await boot();

    expect((await send(`/tenants/${other}/status`, 'kari')).status).toBe(404);
  });
});
