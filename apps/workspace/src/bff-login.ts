import type { Locale } from '@genai/i18n';
import type { AuthClient } from './auth';
import { translator } from './i18n';
import type { Organisation, Session } from './types';

export class LoginError extends Error {
  override name = 'LoginError';
}

export interface BffLoginOptions {
  fetch: typeof fetch;
  navigate: (url: string) => void;
  location: () => URL;
  locale?: () => Locale;
}

interface Me {
  name?: unknown;
  organisation?: unknown;
  organisations?: unknown;
  expiresAt?: unknown;
}

const organisationsOf = (me: Me): Organisation[] => {
  const listed = (Array.isArray(me.organisations) ? me.organisations : [])
    .filter(
      (o): o is { orgNumber: string; name?: unknown } =>
        typeof o === 'object' && o !== null && typeof o.orgNumber === 'string',
    )
    .map((o) => ({
      orgNumber: o.orgNumber,
      name: typeof o.name === 'string' && o.name ? o.name : o.orgNumber,
    }));
  const chosen = (o: Organisation) => Number(o.orgNumber === me.organisation);
  return listed.sort((a, b) => chosen(b) - chosen(a));
};

const never = <T>() => new Promise<T>(() => undefined);

export const bffLogin = ({
  fetch: send,
  navigate,
  location,
  locale = () => 'nb',
}: BffLoginOptions): AuthClient => {
  let session: Session | undefined;
  let endsAt: number | undefined;

  const signedOut = () => {
    session = undefined;
    endsAt = undefined;
    return undefined;
  };

  const read = async (): Promise<Session | undefined> => {
    const response = await send('/auth/me', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    const body = (await response.json().catch(() => undefined)) as Me | undefined;
    if (typeof body !== 'object' || body === null)
      throw new LoginError(`/auth/me answered ${response.status} without JSON`);
    if (response.status === 401) return signedOut();
    if (!response.ok) throw new LoginError(`/auth/me answered ${response.status}`);
    const expiresAt = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
    session = {
      name:
        typeof body.name === 'string' && body.name
          ? body.name
          : translator(locale())('api.unknownUser'),
      organisations: organisationsOf(body),
    };
    endsAt = Number.isNaN(expiresAt) ? undefined : expiresAt;
    return session;
  };

  return {
    current: () => session,
    restore: read,
    login: () => {
      const here = location();
      navigate(`/auth/login?next=${encodeURIComponent(here.pathname + here.search + here.hash)}`);
      return never();
    },
    logout: (endSession = true) => {
      signedOut();
      if (!endSession) return Promise.resolve();
      navigate('/auth/logout');
      return never();
    },
    expiresAt: () => endsAt,
    refresh: () => read().catch(() => undefined),
  };
};
