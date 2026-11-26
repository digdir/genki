import { LoginError, operatorRole, type AuthClient } from './auth';
import { translator, type Locale } from './i18n';
import type { OperatorSession } from './types';

export interface BffLoginOptions {
  fetch: typeof fetch;
  navigate: (url: string) => void;
  here: () => string;
  locale?: () => Locale;
}

interface Me {
  name?: unknown;
  expiresAt?: unknown;
  operator?: unknown;
  code?: unknown;
}

export const bffLogin = (options: BffLoginOptions): AuthClient => {
  const say = () => translator(options.locale?.() ?? 'nb');
  let session: OperatorSession | undefined;
  let expiresAt: number | undefined;

  const read = async () => {
    const response = await options.fetch('/auth/me', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    const body = (await response.json().catch(() => undefined)) as Me | undefined;
    if (typeof body !== 'object' || body === null) throw new LoginError(say()('api.loginFailed'));
    if (response.status === 401) return undefined;
    if (response.status === 404 && body.code === 'bff-not-configured')
      throw new LoginError(say()('api.loginUnavailable'));
    const ends = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
    if (!response.ok || Number.isNaN(ends)) throw new LoginError(say()('api.loginFailed'));
    return {
      session: {
        name: typeof body.name === 'string' && body.name ? body.name : say()('api.unknownUser'),
        roles: body.operator === true ? [operatorRole] : [],
      },
      expiresAt: ends,
    };
  };

  const keep = (found: Awaited<ReturnType<typeof read>>) => {
    session = found?.session;
    expiresAt = found?.expiresAt;
    return session;
  };

  return {
    current: () => session,
    expiresAt: () => (session ? expiresAt : undefined),
    restore: async () => {
      try {
        return keep(await read());
      } catch (error) {
        keep(undefined);
        throw error;
      }
    },
    renew: async () => keep(await read().catch(() => undefined)),
    login: () => {
      const lang = options.locale?.();
      options.navigate(
        `/auth/login?next=${encodeURIComponent(options.here())}${lang ? `&lang=${lang}` : ''}`,
      );
      return new Promise<OperatorSession>(() => undefined);
    },
    logout: async () => {
      keep(undefined);
      options.navigate('/auth/logout');
    },
    expire: () => {
      keep(undefined);
    },
  };
};
