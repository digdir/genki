import { describe, expect, it } from 'vitest';
import { createAuthenticator } from './authenticate.js';

const token = [
  Buffer.from('{"alg":"none"}').toString('base64url'),
  Buffer.from('{"iss":"http://ansattporten.test","sub":"kari"}').toString('base64url'),
  'signature',
].join('.');

const counted = () => {
  const calls = { verify: 0, remembered: 0 };
  const auth = createAuthenticator({
    verifier: {
      verify: async () => {
        calls.verify++;
        return {
          principal: { kind: 'employee', issuer: 'http://ansattporten.test', subject: 'kari' },
          personId: '01017012345',
        };
      },
    },
    onVerified: () => {
      calls.remembered++;
    },
  });
  return { calls, auth };
};

const request = () =>
  new Request('https://api.test/models', { headers: { authorization: `Bearer ${token}` } });

describe('authentication per request', () => {
  it('verifies a token once per request, however many middlewares ask', async () => {
    const { calls, auth } = counted();
    const one = request();

    await Promise.all([auth.check(one), auth.authenticate(one), auth.principalOf(one)]);
    await auth.check(one);

    expect(calls).toEqual({ verify: 1, remembered: 1 });
  });

  it('never reuses a verification for another request with the same token', async () => {
    const { calls, auth } = counted();

    await auth.check(request());
    await auth.check(request());

    expect(calls.verify).toBe(2);
  });
});
