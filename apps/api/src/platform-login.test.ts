import { hkdfSync } from 'node:crypto';
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

  it('keeps a person’s subject after CONTENT_MASTER_KEY is removed when PLATFORM_LOGIN_SUBJECT_KEY holds the key derived from it', () => {
    const master = Buffer.alloc(32, 1).toString('base64');
    const login = { PLATFORM_LOGIN_CLIENT_ID: 'c', PLATFORM_LOGIN_HOSTNAME: 'login.example.no' };
    const before = platformLoginFrom({ ...login, CONTENT_MASTER_KEY: master }, 'digdir:genai');
    const derived = Buffer.from(
      hkdfSync('sha256', Buffer.from(master, 'base64'), '', 'genki platform login subject', 32),
    ).toString('base64');
    const after = platformLoginFrom(
      {
        ...login,
        CONTENT_MASTER_KEY_2: Buffer.alloc(32, 2).toString('base64'),
        PLATFORM_LOGIN_SUBJECT_KEY: derived,
      },
      'digdir:genai',
    );
    expect(after?.subjectKeyKept).toBe(true);
    expect(after?.subjectKey).toEqual(before?.subjectKey);
    expect(
      platformLoginFrom({ ...login, PLATFORM_LOGIN_SUBJECT_KEY: master }, 'digdir:genai')
        ?.subjectKey,
    ).toEqual(new Uint8Array(Buffer.from(master, 'base64')));
  });

  it('refuses the platform login with a database but no key to derive subjects from', () => {
    const env = {
      PLATFORM_LOGIN_CLIENT_ID: 'c',
      PLATFORM_LOGIN_HOSTNAME: 'login.example.no',
      DATABASE_URL: 'postgres://localhost/genai',
      CONTENT_MASTER_KEY_2: Buffer.alloc(32, 2).toString('base64'),
    };
    expect(() => platformLoginFrom(env, 'digdir:genai')).toThrow('PLATFORM_LOGIN_SUBJECT_KEY');
  });

  it('refuses a platform login subject key that is not 32 bytes in base64', () => {
    const env = {
      PLATFORM_LOGIN_CLIENT_ID: 'c',
      PLATFORM_LOGIN_HOSTNAME: 'login.example.no',
      PLATFORM_LOGIN_SUBJECT_KEY: 'too-short',
    };
    expect(() => platformLoginFrom(env, 'digdir:genai')).toThrow('32 bytes');
  });
});
