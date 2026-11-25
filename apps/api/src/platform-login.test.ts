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

  const login = {
    PLATFORM_LOGIN_CLIENT_ID: 'c',
    PLATFORM_LOGIN_HOSTNAME: 'login.apps.genki-test.digdir.cloud',
  };

  it('gives the portal, workspace and console the origins in PLATFORM_APP_ORIGINS', () => {
    const settings = platformLoginFrom(
      {
        ...login,
        PLATFORM_APP_ORIGINS:
          'portal=https://portal.genki-test.digdir.cloud, console=https://Console.genki-test.digdir.cloud/',
      },
      'digdir:genai',
    );
    expect(settings?.origin).toBe('https://login.apps.genki-test.digdir.cloud');
    expect(settings?.apps).toEqual([
      {
        app: 'portal',
        hostname: 'portal.genki-test.digdir.cloud',
        origin: 'https://portal.genki-test.digdir.cloud',
      },
      {
        app: 'console',
        hostname: 'console.genki-test.digdir.cloud',
        origin: 'https://console.genki-test.digdir.cloud',
      },
    ]);
  });

  it.each([
    ['an http origin', 'portal=http://portal.example.no'],
    ['an origin with a path', 'portal=https://portal.example.no/app'],
    ['an unknown app', 'admin=https://admin.example.no'],
    ['an app twice', 'portal=https://a.example.no,portal=https://b.example.no'],
    ['two apps on one hostname', 'portal=https://a.example.no,console=https://a.example.no'],
    ['an app on the login host', 'portal=https://login.apps.genki-test.digdir.cloud'],
    ['http on localhost outside dev mode', 'portal=http://portal.localhost:5173'],
  ])('refuses PLATFORM_APP_ORIGINS with %s', (_, value) => {
    expect(() =>
      platformLoginFrom({ ...login, PLATFORM_APP_ORIGINS: value }, 'digdir:genai'),
    ).toThrow('PLATFORM_APP_ORIGINS');
  });

  it('takes http origins on localhost and a localhost login host only in dev mode', () => {
    const local = {
      PLATFORM_LOGIN_CLIENT_ID: 'c',
      PLATFORM_LOGIN_HOSTNAME: 'localhost',
      PLATFORM_LOGIN_ORIGIN: 'http://localhost:5173',
      PLATFORM_APP_ORIGINS: 'portal=http://portal.localhost:5173',
    };
    expect(platformLoginFrom({ ...local, GENAI_DEV_MODE: 'true' }, 'digdir:genai')).toMatchObject({
      hostname: 'localhost',
      origin: 'http://localhost:5173',
      apps: [{ app: 'portal', origin: 'http://portal.localhost:5173' }],
    });
    expect(platformLoginFrom(local, 'digdir:genai')).toBeUndefined();
  });
});
