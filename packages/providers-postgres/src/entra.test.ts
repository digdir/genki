import { describe, expect, it, vi } from 'vitest';
import { cachedEntraPassword, postgresSourceFromEnv, type TokenSource } from './entra.js';
import { entraPostgresScope } from './pool.js';

const minutes = (n: number) => n * 60_000;

describe('Postgres with Entra ID', () => {
  it('asks for a Postgres token and reuses it until five minutes before it expires', async () => {
    let now = 0;
    const getToken = vi.fn<TokenSource>(async () => ({
      token: `token-at-${now}`,
      expiresOnTimestamp: now + minutes(60),
    }));
    const password = cachedEntraPassword(getToken, () => now);

    expect(await password()).toBe('token-at-0');
    now = minutes(54);
    expect(await password()).toBe('token-at-0');
    now = minutes(56);
    expect(await password()).toBe(`token-at-${minutes(56)}`);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledWith(entraPostgresScope);
  });

  it('shares one token request between connections opened at the same time', async () => {
    const getToken = vi.fn<TokenSource>(async () => ({
      token: 't',
      expiresOnTimestamp: minutes(60),
    }));
    const password = cachedEntraPassword(getToken, () => 0);

    await Promise.all([password(), password(), password()]);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('fails the connection when Entra ID returns no token', async () => {
    const password = cachedEntraPassword(async () => null);
    await expect(password()).rejects.toThrow('no token');
  });

  it('prefers DATABASE_URL, then builds the connection from PGHOST with a token as the password', async () => {
    const tokens: TokenSource = async () => ({
      token: 'entra',
      expiresOnTimestamp: Date.now() + minutes(60),
    });
    expect(
      postgresSourceFromEnv({ DATABASE_URL: 'postgres://db/genai', PGHOST: 'x' }, tokens),
    ).toEqual({
      connectionString: 'postgres://db/genai',
    });
    expect(postgresSourceFromEnv({}, tokens)).toBeUndefined();

    const source = postgresSourceFromEnv(
      {
        PGHOST: 'pg.example',
        PGUSER: 'genki-test-api-id',
        PGDATABASE: 'genai',
        PGSSLMODE: 'require',
      },
      tokens,
    );
    expect(source).toMatchObject({
      host: 'pg.example',
      user: 'genki-test-api-id',
      database: 'genai',
      ssl: { rejectUnauthorized: true },
    });
    expect(typeof source?.password).toBe('function');
    expect(await (source?.password as () => Promise<string>)()).toBe('entra');
  });
});
