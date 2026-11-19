import { describe, expect, it } from 'vitest';
import { platformLoginFrom } from './platform-login.js';

describe('the platform login settings', () => {
  it('turns the platform login off unless its client id and login host are set', () => {
    expect(platformLoginFrom({}, 'digdir:genai')).toBeUndefined();
    expect(platformLoginFrom({ PLATFORM_LOGIN_CLIENT_ID: 'c' }, 'digdir:genai')).toBeUndefined();
    expect(
      platformLoginFrom(
        { PLATFORM_LOGIN_CLIENT_ID: 'c', PLATFORM_LOGIN_HOSTNAME: 'https://login.example.no' },
        'digdir:genai',
      ),
    ).toBeUndefined();
    expect(
      platformLoginFrom(
        {
          PLATFORM_LOGIN_CLIENT_ID: 'c',
          PLATFORM_LOGIN_HOSTNAME: 'Login.Apps.genki-test.digdir.cloud',
          PLATFORM_LOGIN_CLIENT_SECRET: 's',
        },
        'digdir:genai',
      ),
    ).toMatchObject({
      clientId: 'c',
      secret: 's',
      hostname: 'login.apps.genki-test.digdir.cloud',
      audience: 'digdir:genai',
    });
  });

  it('keeps a person’s subject per Client across restarts with the content master key, and only then', () => {
    const env = {
      PLATFORM_LOGIN_CLIENT_ID: 'c',
      PLATFORM_LOGIN_HOSTNAME: 'login.example.no',
      CONTENT_MASTER_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    const first = platformLoginFrom(env, 'digdir:genai');
    const second = platformLoginFrom(env, 'digdir:genai');
    expect(first?.subjectKeyKept).toBe(true);
    expect(second?.subjectKey).toEqual(first?.subjectKey);
    expect(first?.subjectKey).not.toEqual(new Uint8Array(Buffer.alloc(32, 1)));
    const without = { ...env, CONTENT_MASTER_KEY: undefined };
    const unkept = platformLoginFrom(without, 'digdir:genai');
    expect(unkept?.subjectKeyKept).toBe(false);
    expect(platformLoginFrom(without, 'digdir:genai')?.subjectKey).not.toEqual(unkept?.subjectKey);
  });
});
