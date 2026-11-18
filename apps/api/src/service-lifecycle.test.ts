import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { actorNames } from './actor-names.js';
import { bootPlatform, digdir } from './testkit.js';

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: digdir,
  authorizedFor: [{ org: digdir }],
};

describe('the lifecycle of a service', () => {
  it('names the person who paused it', async () => {
    const { send, configEntries } = await bootPlatform({ people: { kari }, services: ['hjelper'] });
    await actorNames(configEntries).remember(kari, 'Kari Nordmann');

    const paused = await send(`/tenants/${digdir}/services/hjelper/lifecycle`, 'kari', {
      method: 'PUT',
      body: { state: 'paused' },
      reason: 'Svarene må sjekkes',
    });
    const read = await send(`/tenants/${digdir}/services/hjelper/lifecycle`, 'kari');

    expect(paused.status).toBe(200);
    for (const view of [await paused.json(), await read.json()])
      expect(view).toMatchObject({
        state: 'paused',
        by: 'employee:test:kari',
        byName: 'Kari Nordmann',
        reason: 'Svarene må sjekkes',
      });
  });
});
