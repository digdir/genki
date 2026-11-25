import { hkdfSync, randomBytes } from 'node:crypto';
import { isHostname } from '@genai/identity';

export interface PlatformLoginSettings {
  clientId: string;
  secret: string | undefined;
  hostname: string;
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
  if (!clientId || !hostname || !isHostname(hostname)) return undefined;
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
  return {
    clientId,
    secret: env.PLATFORM_LOGIN_CLIENT_SECRET?.trim() || undefined,
    hostname,
    audience,
    ...subjectKeyFrom(subjectKey, master),
  };
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
