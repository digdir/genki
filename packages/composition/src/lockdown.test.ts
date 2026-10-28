import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import {
  configuredCredentialScope,
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
});
