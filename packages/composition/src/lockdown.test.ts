import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import {
  configuredCredentialScope,
  serviceEntraScope,
  memberEntraScope,
  isAdmittedEntraLogin,
  isTrustedEntraLogin,
  mayInvokeServices,
  mayUseModels,
  readOnlyInLockdown,
  trustedEntraScope,
} from './lockdown.js';

describe('Entra logins in lockdown', () => {
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

  it('lets a service-group login invoke its service but nothing else that needs admission', () => {
    const unconfined: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'ansatt',
      scopes: [serviceEntraScope],
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

  it('admits a member-group login like a trusted Entra login, but only as a person', () => {
    const user: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'bruker',
      scopes: [memberEntraScope],
    };
    const key: Principal = {
      kind: 'agency-system',
      issuer: 'test',
      subject: 'key',
      scopes: [memberEntraScope],
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
