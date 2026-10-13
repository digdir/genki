import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import {
  createMockAltinnPdp,
  PLATFORM_RESOURCE,
  PLATFORM_RIGHTS,
  platformRightsFromActions,
  platformRightsOf,
  type IdentityTestDataInput,
} from './index.js';

const DIGDIR = '991825827';
const NAV = '889640782';
const FITNESS = '897069651';
const OTHER = 'urn:altinn:resource:digdir-kunnskapsassistent';

const data: IdentityTestDataInput = {
  organisations: [
    { orgno: DIGDIR, name: 'Digitaliseringsdirektoratet' },
    { orgno: NAV, name: 'NAV' },
    { orgno: FITNESS, name: 'DDG Fitness Oslo', unitType: 'BEDR' },
  ],
  resourcePolicies: {
    [PLATFORM_RESOURCE]: {
      rules: [
        { roles: ['DAGL'], actions: ['read', 'write'] },
        { accessPackages: ['urn:altinn:accesspackage:ki-tjenester'], actions: ['use-services'] },
      ],
    },
  },
  persons: [
    {
      pid: '01017012345',
      name: 'Datasett Admin',
      parties: [
        {
          orgno: DIGDIR,
          resources: { [PLATFORM_RESOURCE]: ['use-services', 'manage-datasets'] },
        },
        { orgno: FITNESS, accessPackages: ['urn:altinn:accesspackage:ki-tjenester'] },
      ],
    },
    { pid: '02027012345', name: 'Gammel Leder', parties: [{ orgno: NAV, roles: ['DAGL'] }] },
  ],
};

const decide = (pid: string, party: string, action: string) =>
  createMockAltinnPdp(data).authorization.decide({
    subject: { personId: pid },
    action,
    resource: PLATFORM_RESOURCE,
    party,
  });

const employee = (authorizedFor: Principal['authorizedFor']): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject: 'someone',
  ...(authorizedFor ? { authorizedFor } : {}),
});

describe('platform rights', () => {
  it('the mock PDP grants the finer actions from test data', async () => {
    expect(await decide('01017012345', DIGDIR, 'manage-datasets')).toBe('Permit');
    expect(await decide('01017012345', DIGDIR, 'use-services')).toBe('Permit');
    expect(await decide('01017012345', DIGDIR, 'manage-services')).toBe('NotApplicable');
    expect(await decide('01017012345', FITNESS, 'use-services')).toBe('Permit');
    expect(await decide('01017012345', FITNESS, 'view-usage')).toBe('NotApplicable');
  });

  it('old read/write responses map to the new rights', async () => {
    expect(platformRightsFromActions(['read'])).toEqual(['use-services', 'view-usage']);
    expect(platformRightsFromActions(['write'])).toEqual([
      'manage-services',
      'manage-datasets',
      'register-building-blocks',
      'view-usage',
    ]);
    expect(platformRightsFromActions(['read', 'write'])).toEqual([...PLATFORM_RIGHTS]);
    expect(platformRightsFromActions(['read', 'write', 'use-services'])).toEqual(['use-services']);
    expect(await decide('02027012345', NAV, 'register-building-blocks')).toBe('Permit');
    expect(await decide('02027012345', NAV, 'write')).toBe('Permit');
  });

  it('derives the rights a principal carries for one tenant and resource', () => {
    const principal = employee([
      { org: DIGDIR, resource: 'digdir-genai-platform', actions: ['read'] },
      { org: DIGDIR, resource: OTHER, actions: ['write'] },
      { org: NAV, resource: PLATFORM_RESOURCE, actions: ['manage-datasets'] },
    ]);

    expect(platformRightsOf(principal, DIGDIR)).toEqual(['use-services', 'view-usage']);
    expect(platformRightsOf(principal, NAV)).toEqual(['manage-datasets']);
    expect(platformRightsOf(principal, FITNESS)).toEqual([]);
  });

  it('keeps tenant-wide access for principals that carry no Altinn actions', () => {
    expect(platformRightsOf({ ...employee(undefined), tenant: DIGDIR }, DIGDIR)).toEqual([
      ...PLATFORM_RIGHTS,
    ]);
    expect(platformRightsOf(employee([{ org: DIGDIR }]), DIGDIR)).toEqual([...PLATFORM_RIGHTS]);
    expect(platformRightsOf({ ...employee(undefined), tenant: NAV }, DIGDIR)).toEqual([]);
    expect(
      platformRightsOf({ kind: 'operator', issuer: 'test', subject: 'drift' }, DIGDIR),
    ).toEqual([...PLATFORM_RIGHTS]);
  });
});
