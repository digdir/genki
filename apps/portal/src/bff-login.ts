import { negotiate, resolveLocale } from '@genai/i18n';
import type { AuthClient } from './auth';
import { translator } from './i18n';
import type { Session } from './types';

export interface BffLoginOptions {
  fetch: typeof fetch;
  navigate: (url: string) => void;
  location: () => URL;
  uiLocale?: () => string;
}

interface Me {
  name: string | null;
  organisations: { orgNumber: string; name?: string }[];
  expiresAt: string;
}

export class LoginError extends Error {
  override name = 'LoginError';
}

export const bffLogin = (options: BffLoginOptions): AuthClient => {
  let session: Session | undefined;
  let expiresAt: number | undefined;
  let unavailable = false;
  let restoring: Promise<Session | undefined> | undefined;

  const read = async (): Promise<Session | undefined> => {
    const response = await options.fetch('/auth/me', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    const json = (response.headers.get('content-type') ?? '').includes('json');
    if (response.status === 401 && json) {
      session = undefined;
      expiresAt = undefined;
      return undefined;
    }
    if (!response.ok || !json) {
      unavailable = response.status === 404 || !json;
      throw new LoginError(`/auth/me answered ${response.status}`);
    }
    const me = (await response.json()) as Me;
    const at = Date.parse(me.expiresAt);
    session = {
      name: me.name || translator(resolveLocale(options.uiLocale?.()))('app.unknownUser'),
      organisations: me.organisations.map(({ orgNumber, name }) => ({
        orgNumber,
        name: name ?? orgNumber,
      })),
    };
    expiresAt = Number.isNaN(at) ? undefined : at;
    return session;
  };

  return {
    current: () => session,
    restore: () => (restoring ??= read()),
    login: () => {
      if (unavailable) return Promise.reject(new LoginError('the platform login is not served'));
      const here = options.location();
      const next = `${here.pathname}${here.search}${here.hash}`;
      const lang = negotiate(options.uiLocale?.());
      options.navigate(
        `/auth/login?next=${encodeURIComponent(next)}${lang ? `&lang=${lang}` : ''}`,
      );
      return new Promise<Session>(() => undefined);
    },
    logout: async (endSession = false) => {
      session = undefined;
      expiresAt = undefined;
      if (endSession) options.navigate('/auth/logout');
    },
    expiresAt: () => (session ? expiresAt : undefined),
    refresh: async () => {
      const before = expiresAt;
      const renewed = await read().catch(() => undefined);
      return renewed && expiresAt !== undefined && (before === undefined || expiresAt > before)
        ? renewed
        : undefined;
    },
  };
};
