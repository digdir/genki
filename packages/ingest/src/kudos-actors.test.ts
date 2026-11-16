import { describe, expect, it } from 'vitest';
import { kudosClient, kudosProd } from './kudos.js';
import { kudosRateLimiter } from './kudos-rate.js';

describe('the Kudos client', () => {
  it('lists Kudos actors fifty to a page under the rate limiter', async () => {
    const asked: string[] = [];
    let taken = 0;
    const limiter = { ...kudosRateLimiter(), take: async () => void taken++ };
    const client = kudosClient({
      profile: kudosProd,
      limiter,
      fetch: async (url) => {
        asked.push(String(url));
        return Response.json({
          data: [
            {
              org_number: 991825827,
              alternative_names: [{ type: 'abbreviation', name: 'Digdir' }],
            },
          ],
          meta: { current_page: 2, last_page: 28 },
        });
      },
    });

    const page = await client.actors(2);

    expect(asked).toEqual(['https://kudos.dfo.no/api/v0/actors?page=2&per_page=50']);
    expect(taken).toBe(1);
    expect(page.data[0]?.org_number).toBe(991825827);
  });
});
