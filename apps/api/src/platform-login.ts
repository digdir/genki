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
  return {
    clientId,
    secret: env.PLATFORM_LOGIN_CLIENT_SECRET?.trim() || undefined,
    hostname,
    audience,
    ...subjectKeyFrom(env.CONTENT_MASTER_KEY),
  };
};

/** Derived from the content master key, so a person keeps their subject on a Client across restarts. */
const subjectKeyFrom = (master: string | undefined) =>
  master
    ? {
        subjectKey: new Uint8Array(
          hkdfSync('sha256', Buffer.from(master, 'base64'), '', 'genki platform login subject', 32),
        ),
        subjectKeyKept: true,
      }
    : { subjectKey: new Uint8Array(randomBytes(32)), subjectKeyKept: false };
