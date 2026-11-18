import type { Principal, Ref } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import {
  personKeys,
  PLATFORM_RESOURCE,
  serviceAccessPolicy,
  type IdentityLookup,
} from './index.js';

const ORG = '991825827';
const key = personKeys('test-secret');
const kari: Principal = { kind: 'employee', issuer: 'ap', subject: 'kari', tenant: ORG };
const per: Principal = { kind: 'employee', issuer: 'ap', subject: 'per', tenant: ORG };
const entra: Principal = { kind: 'employee', issuer: 'entra', subject: 'x', tenant: ORG };
const pids: Record<string, string> = { kari: '01017012345', per: '02027012345' };
const identities: IdentityLookup = { personId: async (_issuer, subject) => pids[subject] };
const service = (id: string, tenant = ORG): Ref => ({
  kind: 'capability',
  id: `${tenant}/${id}/default`,
  tenant,
});

const policy = (selected: Record<string, string[]>, fail = false) =>
  serviceAccessPolicy(
    { decide: async () => ({ allow: true }) },
    {
      identities,
      key,
      selectedFor: async (tenant, id) => {
        if (fail) throw new Error('store down');
        return tenant === ORG ? selected[id] : undefined;
      },
    },
  );

describe('access to a service limited to selected people', () => {
  it('lets anyone the inner policy allows invoke a service with no selection', async () => {
    expect((await policy({}).decide(per, 'invoke', service('rapport'))).allow).toBe(true);
  });

  it('leaves a service with no limit open to a login with no known person', async () => {
    const decision = await policy({ rapport: [key(pids.kari as string)] }).decide(
      entra,
      'invoke',
      service('oversetter'),
    );
    expect(decision.allow).toBe(true);
  });

  it('lets a selected person invoke the service', async () => {
    const decision = await policy({ rapport: [key(pids.kari as string)] }).decide(
      kari,
      'invoke',
      service('rapport'),
    );
    expect(decision.allow).toBe(true);
  });

  it('refuses a person who is not selected', async () => {
    const decision = await policy({ rapport: [key(pids.kari as string)] }).decide(
      per,
      'invoke',
      service('rapport'),
    );
    expect(decision).toMatchObject({ allow: false });
  });

  it('refuses a login with no known person when the service is limited', async () => {
    const decision = await policy({ rapport: [key(pids.kari as string)] }).decide(
      entra,
      'invoke',
      service('rapport'),
    );
    expect(decision.allow).toBe(false);
  });

  it('refuses when the selection cannot be read', async () => {
    expect((await policy({}, true).decide(kari, 'invoke', service('rapport'))).allow).toBe(false);
  });

  it('leaves API keys and machine clients to their own grants', async () => {
    const system: Principal = { kind: 'agency-system', issuer: 'mp', subject: 'c', tenant: ORG };
    const decision = await policy({ rapport: [] }).decide(system, 'invoke', service('rapport'));
    expect(decision.allow).toBe(true);
  });

  it('lets operators through a limited service', async () => {
    const operator: Principal = { kind: 'operator', issuer: 'entra', subject: 'o', tenant: ORG };
    const decision = await policy({ rapport: [] }).decide(operator, 'invoke', service('rapport'));
    expect(decision.allow).toBe(true);
  });

  it('limits a draft run of a limited service like the service itself, except for people who manage services', async () => {
    const draft: Ref = {
      kind: 'capability',
      id: 'platform/draft/playground/abc',
      tenant: 'platform',
    };
    const drafts = serviceAccessPolicy(
      { decide: async () => ({ allow: true }) },
      {
        identities,
        key,
        selectedFor: async (_tenant, id) =>
          id === 'rapport' ? [key(pids.kari as string)] : undefined,
        draftServiceOf: (id) => (id === draft.id ? { tenant: ORG, service: 'rapport' } : undefined),
      },
    );
    const datasetsOnly: Principal = {
      ...per,
      authorizedFor: [{ org: ORG, resource: PLATFORM_RESOURCE, actions: ['manage-datasets'] }],
    };
    const manager: Principal = {
      ...per,
      authorizedFor: [{ org: ORG, resource: PLATFORM_RESOURCE, actions: ['manage-services'] }],
    };
    expect((await drafts.decide(datasetsOnly, 'invoke', draft)).allow).toBe(false);
    expect((await drafts.decide(manager, 'invoke', draft)).allow).toBe(true);
    expect((await drafts.decide(kari, 'invoke', draft)).allow).toBe(true);
  });

  it('does not limit other actions than invoking', async () => {
    expect((await policy({ rapport: [] }).decide(per, 'read', service('rapport'))).allow).toBe(
      true,
    );
  });
});
