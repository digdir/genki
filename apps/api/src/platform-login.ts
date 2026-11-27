import { hkdfSync, randomBytes } from 'node:crypto';
import { isDevMode } from '@genai/composition';
import { isHostname } from '@genai/identity';
import { platformApps, type PlatformApp } from './bff/acting.js';

export interface PlatformAppOrigin {
  app: PlatformApp;
  hostname: string;
  origin: string;
}

export interface PlatformLoginSettings {
  clientId: string;
  secret: string | undefined;
  hostname: string;
  origin: string;
  apps: PlatformAppOrigin[];
  audience: string;
  subjectKey: Uint8Array;
  subjectKeyKept: boolean;
}

/** genki's own Ansattporten client for hosted assistants (ADR 0061), off unless its id and login host are set. */
export const platformLoginFrom = (
  env: NodeJS.ProcessEnv,
  audience: string,
): PlatformLoginSettings | undefined => {
  const clientId = env.PLATFORM_LOGIN_CLIENT_ID?.trim();
  const hostname = env.PLATFORM_LOGIN_HOSTNAME?.trim().toLowerCase();
  if (!clientId || !hostname || !(isHostname(hostname) || localLoginHost(env, hostname)))
    return undefined;
  const subjectKey = env.PLATFORM_LOGIN_SUBJECT_KEY?.trim();
  const master = env.CONTENT_MASTER_KEY?.trim();
  for (const [name, value] of [
    ['PLATFORM_LOGIN_SUBJECT_KEY', subjectKey],
    ['CONTENT_MASTER_KEY', master],
  ] as const)
    if (value && Buffer.from(value, 'base64').length !== 32)
      throw new Error(`${name} must be 32 bytes in base64`);
  if (!subjectKey && !master && (env.DATABASE_URL || env.PGHOST))
    throw new Error(
      'the platform login needs PLATFORM_LOGIN_SUBJECT_KEY or CONTENT_MASTER_KEY when a database is set',
    );
  const origin = loginOriginOf(env, hostname);
  return {
    clientId,
    secret: env.PLATFORM_LOGIN_CLIENT_SECRET?.trim() || undefined,
    hostname,
    origin,
    apps: platformAppOriginsFrom(env, [hostname]),
    audience,
    ...subjectKeyFrom(subjectKey, master),
  };
};

/** Plain `localhost` as the login host, in dev mode only, so a TEST Ansattporten client can register it. */
const localLoginHost = (env: NodeJS.ProcessEnv, hostname: string) =>
  hostname === 'localhost' && isDevMode(env) && Boolean(env.PLATFORM_LOGIN_ORIGIN?.trim());

/** An https origin, or in dev mode an http origin on a `*.localhost` name, with no path. */
const appOrigin = (env: NodeJS.ProcessEnv, value: string, name: string) => {
  const url = URL.canParse(value) ? new URL(value) : undefined;
  const local = url?.hostname === 'localhost' || url?.hostname.endsWith('.localhost');
  if (
    !url ||
    url.origin !== value.replace(/\/$/, '').toLowerCase() ||
    !(isHostname(url.hostname) || localLoginHost(env, url.hostname)) ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && local && isDevMode(env)))
  )
    throw new Error(`${name} must be https origins, or http on *.localhost in dev mode`);
  return { hostname: url.hostname, origin: url.origin };
};

const loginOriginOf = (env: NodeJS.ProcessEnv, hostname: string) => {
  const given = env.PLATFORM_LOGIN_ORIGIN?.trim();
  if (!given) return `https://${hostname}`;
  const parsed = appOrigin(env, given, 'PLATFORM_LOGIN_ORIGIN');
  if (parsed.hostname !== hostname)
    throw new Error('PLATFORM_LOGIN_ORIGIN must be on PLATFORM_LOGIN_HOSTNAME');
  return parsed.origin;
};

/** `PLATFORM_APP_ORIGINS`: `portal=<origin>,console=<origin>`, which sign in through the platform login. */
export const platformAppOriginsFrom = (
  env: NodeJS.ProcessEnv,
  taken: readonly string[] = [],
): PlatformAppOrigin[] => {
  const found: PlatformAppOrigin[] = [];
  for (const entry of (env.PLATFORM_APP_ORIGINS ?? '').split(',')) {
    if (!entry.trim()) continue;
    const at = entry.indexOf('=');
    const app = entry.slice(0, at).trim() as PlatformApp;
    if (at < 0 || !platformApps.includes(app) || found.some((f) => f.app === app))
      throw new Error('PLATFORM_APP_ORIGINS must name portal and console at most once');
    const origin = appOrigin(env, entry.slice(at + 1).trim(), 'PLATFORM_APP_ORIGINS');
    if ([...taken, ...found.map((f) => f.hostname)].includes(origin.hostname))
      throw new Error('PLATFORM_APP_ORIGINS must give each app a hostname of its own');
    found.push({ app, ...origin });
  }
  return found;
};

const platformLoginSubjectKey = (master: string): Uint8Array =>
  new Uint8Array(
    hkdfSync('sha256', Buffer.from(master, 'base64'), '', 'genki platform login subject', 32),
  );

/** PLATFORM_LOGIN_SUBJECT_KEY, or derived from the content master key, so a person keeps their subject on a Client across restarts. */
const subjectKeyFrom = (subjectKey: string | undefined, master: string | undefined) =>
  subjectKey
    ? { subjectKey: new Uint8Array(Buffer.from(subjectKey, 'base64')), subjectKeyKept: true }
    : master
      ? { subjectKey: platformLoginSubjectKey(master), subjectKeyKept: true }
      : { subjectKey: new Uint8Array(randomBytes(32)), subjectKeyKept: false };
