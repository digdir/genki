import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import {
  configuredCredentialScope,
  lockdownServiceScope,
  lockdownUserScope,
  isAdmittedEntraLogin,
  isTrustedEntraLogin,
  mayInvokeServices,
  mayUseModels,
  readOnlyInLockdown,
  trustedEntraFrom,
  trustedEntraScope,
} from './lockdown.js';

const group = '0f0e0d0c-0b0a-4908-8706-050403020100';
const resource = 'urn:altinn:resource:digdir-genai-platform-test';

describe('Entra logins in lockdown', () => {
  it('trusts Entra groups only in lockdown and only when groups are configured', () => {
    const locked = { GENAI_LOCKDOWN: 'true', LOCKDOWN_ENTRA_GROUPS: ` ${group} ` };

    expect(
      trustedEntraFrom(
        { ...locked, OPERATOR_CLIENT_IDS: ' console , portal ' },
        '312521172',
        resource,
      ),
    ).toEqual({
      groups: [group],
      clientIds: ['console', 'portal'],
      tenant: '312521172',
      resource,
    });
    expect(
      trustedEntraFrom({ ...locked, LOCKDOWN_ENTRA_EMAIL_DOMAIN: '@digdir.example' }, '1', resource)
        ?.emailDomain,
    ).toBe('digdir.example');
    expect(trustedEntraFrom({ LOCKDOWN_ENTRA_GROUPS: group }, '1', resource)).toBeUndefined();
    expect(trustedEntraFrom({ GENAI_LOCKDOWN: 'true' }, '1', resource)).toBeUndefined();
  });

  it('lets a trusted Entra login use models and keeps other people read-only', () => {
    const entra: Principal = {
      kind: 'operator',
      issuer: 'test',
      subject: 'entra',
      scopes: [trustedEntraScope],
    };
    const testId: Principal = { kind: 'employee', issuer: 'test', subject: 'kari' };
    const personWithKeyScope: Principal = { ...testId, scopes: [configuredCredentialScope] };
    const key: Principal = {
      kind: 'agency-system',
      issuer: 'test',
      subject: 'key',
      scopes: [configuredCredentialScope],
    };

    expect([entra, testId, personWithKeyScope, key].map(mayUseModels)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    expect([entra, testId, key].map(readOnlyInLockdown)).toEqual([false, true, false]);
  });

  it('reads LOCKDOWN_USER_GROUPS alongside the operator groups, also without them', () => {
    const userGroup = '11111111-2222-4333-8444-555555555555';
    const locked = { GENAI_LOCKDOWN: 'true', OPERATOR_CLIENT_IDS: 'portal' };

    expect(
      trustedEntraFrom({ ...locked, LOCKDOWN_USER_GROUPS: ` ${userGroup} ` }, '1', resource),
    ).toEqual({
      groups: [],
      userGroups: [userGroup],
      clientIds: ['portal'],
      tenant: '1',
      resource,
    });
    expect(trustedEntraFrom({ LOCKDOWN_USER_GROUPS: userGroup }, '1', resource)).toBeUndefined();
  });

  it('reads LOCKDOWN_SERVICE_GROUPS with their own client list, also without other groups', () => {
    const serviceGroup = '2a2b2c2d-3e3f-4a4b-8c8d-9e9f0a0b0c0d';
    const locked = { GENAI_LOCKDOWN: 'true', LOCKDOWN_SERVICE_CLIENT_IDS: ' ka-web ' };

    expect(
      trustedEntraFrom({ ...locked, LOCKDOWN_SERVICE_GROUPS: serviceGroup }, '1', resource),
    ).toEqual({
      groups: [],
      serviceGroups: [serviceGroup],
      serviceClientIds: ['ka-web'],
      clientIds: [],
      tenant: '1',
      resource,
    });
    expect(
      trustedEntraFrom({ LOCKDOWN_SERVICE_GROUPS: serviceGroup }, '1', resource),
    ).toBeUndefined();
  });

  it('lets a service-group login invoke its service but nothing else that needs admission', () => {
    const unconfined: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'ansatt',
      scopes: [lockdownServiceScope],
    };
    const service: Principal = {
      ...unconfined,
      confinedTo: { tenant: '1', service: 'ka', client: 'ka-web' },
    };
    const key: Principal = { ...service, kind: 'agency-system' };

    expect([service, unconfined, key].map(mayInvokeServices)).toEqual([true, false, false]);
    expect(mayUseModels(service)).toBe(false);
    expect(isAdmittedEntraLogin(service)).toBe(false);
    expect(readOnlyInLockdown(service)).toBe(true);
  });

  it('admits a lockdown user like a trusted Entra login, but only as a person', () => {
    const user: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'bruker',
      scopes: [lockdownUserScope],
    };
    const key: Principal = {
      kind: 'agency-system',
      issuer: 'test',
      subject: 'key',
      scopes: [lockdownUserScope],
    };

    expect([isAdmittedEntraLogin(user), mayUseModels(user), readOnlyInLockdown(user)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(isTrustedEntraLogin(user)).toBe(false);
    expect([isAdmittedEntraLogin(key), mayUseModels(key)]).toEqual([false, false]);
  });
});
