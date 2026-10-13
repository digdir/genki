import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import type { DefinitionStore, PublishedVersion } from '@genai/definitions';
import { tenantAccess } from './access.js';
import { AdminRefused, type Admin } from './admin.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { governanceModule } from './governance.js';
import type { ModuleDeps, MountDeps } from './platform-modules.js';
import { digdir } from './testkit.js';

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: digdir },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const highRisk = (by = 'employee:test:kari') => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'vedtak' },
  spec: {
    riskClass: 'high',
    riskConfirmation: { by, at: '2026-10-07T10:00:00.000Z', reasons: [] },
  },
});

const boot = (published?: Partial<PublishedVersion>, refuse = false) => {
  const configEntries = new InMemoryConfigEntryStore();
  const definitions = {
    get: async () => published,
  } as unknown as DefinitionStore;
  const adminTasks: { action: string; target: string }[] = [];
  const governance = governanceModule({ configEntries, definitions } as unknown as ModuleDeps);
  const app = new Hono();
  governance.mount(app, {
    authenticate: async (request: Request) =>
      people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''],
    access: tenantAccess({ supportSession: () => undefined } as unknown as Admin),
    admin: {
      within: async (
        _principal: Principal,
        action: string,
        _data: unknown,
        work: () => Promise<{ value: unknown; target: string }>,
      ) => {
        if (refuse)
          throw new AdminRefused([{ path: 'service', message: 'no service vedtak' }], 'oppgave-2');
        const done = await work();
        adminTasks.push({ action, target: done.target });
        return { value: done.value, task: 'oppgave-1' };
      },
    },
  } as unknown as MountDeps);
  const confirm = (who: string, riskClass = 'high') =>
    app.request(`/tenants/${digdir}/services/vedtak/risk-confirmations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
      body: JSON.stringify({ riskClass }),
    });
  return { governance, confirm, adminTasks };
};

describe('risk governance', () => {
  it('refuses a high-risk service that only one person has confirmed', async () => {
    const { governance, confirm } = boot();
    await confirm('kari');

    const problems = await governance.checkPublish?.(highRisk('employee:test:kari'));

    expect(problems).toEqual([expect.objectContaining({ path: 'spec.riskConfirmation' })]);
  });

  it('publishes a high-risk service once a second person with the publish right confirms it', async () => {
    const { governance, confirm } = boot();

    const confirmed = await confirm('ola');
    const problems = await governance.checkPublish?.(highRisk('employee:test:kari'));

    expect(confirmed.status).toBe(201);
    expect(await confirmed.json()).toMatchObject({ riskClass: 'high', by: 'employee:test:ola' });
    expect(problems).toEqual([]);
  });

  it('a risk confirmation is saved as an admin task', async () => {
    const { confirm, adminTasks } = boot();

    const confirmed = await confirm('ola');

    expect(confirmed.headers.get('genai-task')).toBe('oppgave-1');
    expect(adminTasks).toEqual([
      { action: 'platform.service.risk.confirm', target: 'service:vedtak/risk' },
    ]);
  });

  it('does not count confirmations given before the latest published version', async () => {
    const { governance, confirm } = boot({ publishedAt: '2999-01-01T00:00:00.000Z' });
    await confirm('ola');

    expect(await governance.checkPublish?.(highRisk())).toHaveLength(1);
  });

  it('refuses a high-risk service with no confirmation at all', async () => {
    const { governance } = boot();
    const service = highRisk();
    delete (service.spec as { riskConfirmation?: unknown }).riskConfirmation;

    expect(await governance.checkPublish?.(service)).toHaveLength(1);
  });

  it('only people with the publish right in the tenant can confirm', async () => {
    const { confirm } = boot();

    expect((await confirm('erik')).status).toBe(403);
    expect((await confirm('kari', 'minimal')).status).toBe(400);
  });

  it('answers 404 to an operator without a support session, as for any unreachable tenant', async () => {
    const { confirm } = boot();

    expect((await confirm('drift')).status).toBe(404);
  });

  it('answers a refused confirmation as a problem with its task, never a 500', async () => {
    const { confirm } = boot(undefined, true);

    const refused = await confirm('kari');

    expect(refused.status).toBe(400);
    expect(refused.headers.get('content-type')).toContain('application/problem+json');
    expect(refused.headers.get('genai-task')).toBe('oppgave-2');
    expect(await refused.json()).toMatchObject({ errors: [{ path: 'service' }] });
  });
});
