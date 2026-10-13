import type { VerifiedIdentity } from '@genai/identity';
import { PLATFORM_RESOURCE, platformRightsOf } from '@genai/identity';
import { describe, expect, it } from 'vitest';
import { asPlatformResource } from './platform-resource.js';

const testResource = 'urn:altinn:resource:digdir-genai-platform-test';
const org = '312521172';

const verifierFor = (resource: string) => ({
  verify: async (): Promise<VerifiedIdentity> => ({
    principal: {
      kind: 'employee',
      issuer: 'https://test.ansattporten.no',
      subject: '26906297387',
      authorizedFor: [{ org, resource, actions: ['read', 'write'] }],
    },
  }),
});

describe('the configured Altinn resource', () => {
  it('rights from the configured Altinn resource count as the platform rights', async () => {
    const { principal } = await asPlatformResource(
      verifierFor(testResource),
      testResource,
    ).verify();
    expect(principal.authorizedFor?.[0]?.resource).toBe(PLATFORM_RESOURCE);
    expect(platformRightsOf(principal, org)).toContain('manage-services');
  });

  it('rights on another Altinn resource give no platform rights', async () => {
    const { principal } = await asPlatformResource(
      verifierFor('urn:altinn:resource:some-other-service'),
      testResource,
    ).verify();
    expect(platformRightsOf(principal, org)).toEqual([]);
  });
});
