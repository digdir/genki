import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { bootPlatform, digdir, files, testService } from './testkit.js';

const unregistered = '405003309';
const ingrid: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'ingrid',
  tenant: digdir,
  authorizedFor: [{ org: digdir }, { org: unregistered }],
};

describe('tenant registration', () => {
  it('refuses to publish or validate for an unregistered organisation, and publishing never registers it', async () => {
    const { send } = await bootPlatform({ people: { ingrid } });
    const body = { definition: testService('selvregistrert', unregistered), files };
    for (const path of ['/definitions', '/definitions/validate']) {
      const refused = await send(path, 'ingrid', {
        body,
        reason: 'checking the registration rule',
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { type: string }).type).toBe(
        'urn:genai:problem:tenant-not-registered',
      );
    }
    expect((await send(`/tenants/${unregistered}/datasets`, 'ingrid')).status).toBe(403);
  });

  it('still lets a member publish for a registered organisation', async () => {
    const { send } = await bootPlatform({ people: { ingrid } });
    const published = await send('/definitions', 'ingrid', {
      body: { definition: testService('tillatt', digdir), files },
      reason: 'publishing for a registered tenant',
    });
    expect(published.status).toBe(201);
  });
});
