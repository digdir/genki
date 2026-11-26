import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import type { BffSessionStore } from '../bff/sessions.js';

export const requestMs = 5 * 60_000;
export const codeMs = 60_000;
export const retryMs = 30_000;
export const accessMs = 15 * 60_000;
export const grantMs = 8 * 3600_000;

const hostname = 'design-connector';

export interface PendingRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  scope: string;
  browserHash: string;
  startedAt: number;
}

export interface Grant {
  tenant: string;
  principal: Principal;
  clientId: string;
  refreshHash: string;
  previousHash?: string;
  rotatedAt?: number;
  expiresAt: number;
}

export interface Approval {
  approved: CodeRow['grant'];
  finishHash: string;
}

export interface CodeRow {
  grant: Omit<Grant, 'refreshHash' | 'previousHash' | 'rotatedAt' | 'expiresAt'>;
  redirectUri: string;
  challenge: string;
}

export const randomToken = () => randomBytes(32).toString('base64url');

export const hash = (purpose: string, value: string) =>
  createHash('sha256').update(`design-connector:${purpose}\u0000${value}`).digest('hex');

export const sameHash = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The key that finds every grant and token of one person, so «Koble fra» ends them all. */
export const personKey = (principal: Pick<Principal, 'issuer' | 'subject'>) =>
  hash('person', `${principal.issuer}\u0000${principal.subject}`);

const opaque = /^[A-Za-z0-9_-]{43}$/;

const parse = <T>(payload: string): T | undefined => {
  try {
    return JSON.parse(payload) as T;
  } catch {
    return undefined;
  }
};

/** A grant's token is `<grant id>.<secret>`, so a refresh finds its grant without a scan. */
const split = (token: string) => {
  const [id, secret, ...rest] = token.split('.');
  return id && secret && rest.length === 0 && opaque.test(id) && opaque.test(secret)
    ? { id, secret }
    : undefined;
};

/** Requests, codes, grants and tokens of the design connector, in the BFF's session store. */
export const connectorGrants = (store: BffSessionStore, partition: string, now: () => number) => {
  const row = (client: string, expiresAt: number, payload: unknown, keys?: string[]) => ({
    hostname,
    client,
    expiresAt,
    payload: JSON.stringify(payload),
    ...(keys ? { logoutKeys: keys } : {}),
  });

  const issueTokens = async (grantId: string, grant: Grant) => {
    const access = `${grantId}.${randomToken()}`;
    await store.create(
      partition,
      hash('access', access),
      row('access', Math.min(now() + accessMs, grant.expiresAt), { grantId }, [
        personKey(grant.principal),
      ]),
    );
    return {
      access,
      expiresIn: Math.floor((Math.min(now() + accessMs, grant.expiresAt) - now()) / 1000),
    };
  };

  return {
    async openRequest(request: PendingRequest) {
      const id = randomToken();
      await store.create(
        partition,
        hash('request', id),
        row('request', now() + requestMs, request),
      );
      return id;
    },

    async request(id: string) {
      if (!opaque.test(id)) return undefined;
      const found = await store.get(partition, hash('request', id));
      return found && found.client === 'request' ? parse<PendingRequest>(found.payload) : undefined;
    },

    /** Takes a pending request once: a second approval of the same request finds nothing. */
    async takeRequest(id: string) {
      if (!opaque.test(id)) return undefined;
      const key = hash('request', id);
      const found = await store.get(partition, key);
      if (!found || found.client !== 'request' || !(await store.delete(partition, key)))
        return undefined;
      return parse<PendingRequest>(found.payload);
    },

    /** Records the person's approval of a pending request once, ended by their «Koble fra Claude». */
    async approve(id: string, approved: CodeRow['grant'], finishHash: string) {
      const pending = await this.request(id);
      if (!pending) return false;
      return store.claim(
        partition,
        hash('approval', id),
        row(
          'approval',
          pending.startedAt + requestMs,
          { approved, finishHash } satisfies Approval,
          [personKey(approved.principal)],
        ),
      );
    },

    async withdrawApproval(id: string) {
      if (opaque.test(id)) await store.delete(partition, hash('approval', id));
    },

    async approval(id: string) {
      if (!opaque.test(id)) return undefined;
      const found = await store.get(partition, hash('approval', id));
      return found?.client === 'approval' ? parse<Approval>(found.payload) : undefined;
    },

    /** Takes a pending request and its approval once, whatever they hold. */
    async takeAll(id: string) {
      const request = await this.takeRequest(id);
      if (!opaque.test(id)) return { request };
      const key = hash('approval', id);
      const found = await store.get(partition, key);
      const approval =
        found?.client === 'approval' && (await store.delete(partition, key))
          ? parse<Approval>(found.payload)
          : undefined;
      return { request, approval };
    },

    async endGrant(grantId: string) {
      await store.delete(partition, hash('grant', grantId));
    },

    async issueCode(code: CodeRow) {
      const value = randomToken();
      await store.create(
        partition,
        hash('code', value),
        row('code', now() + codeMs, code, [personKey(code.grant.principal)]),
      );
      return value;
    },

    async takeCode(value: string) {
      if (!opaque.test(value)) return undefined;
      const key = hash('code', value);
      const found = await store.get(partition, key);
      if (!found || found.client !== 'code' || !(await store.delete(partition, key)))
        return undefined;
      return parse<CodeRow>(found.payload);
    },

    async startGrant(code: CodeRow) {
      const grantId = randomToken();
      const refresh = `${grantId}.${randomToken()}`;
      const grant: Grant = {
        ...code.grant,
        refreshHash: hash('refresh', refresh),
        expiresAt: now() + grantMs,
      };
      await store.create(
        partition,
        hash('grant', grantId),
        row('grant', grant.expiresAt, grant, [personKey(grant.principal)]),
      );
      return { ...(await issueTokens(grantId, grant)), refresh, grant };
    },

    /** Rotates a refresh token; an old one used again ends the grant, unless it is a retry within 30 seconds. */
    async refresh(token: string, clientId: string) {
      const parts = split(token);
      if (!parts) return undefined;
      const key = hash('grant', parts.id);
      const presented = hash('refresh', token);
      const next = `${parts.id}.${randomToken()}`;
      let outcome: 'replayed' | 'retried' | undefined;
      const updated = await store.update(partition, key, async (current) => {
        const grant = parse<Grant>(current.payload);
        if (!grant || grant.expiresAt <= now()) return undefined;
        if (grant.clientId !== clientId) {
          outcome = 'retried';
          return current;
        }
        if (!sameHash(grant.refreshHash, presented)) {
          const retry =
            grant.previousHash !== undefined &&
            sameHash(grant.previousHash, presented) &&
            now() - (grant.rotatedAt ?? 0) < retryMs;
          outcome = retry ? 'retried' : 'replayed';
          return retry ? current : undefined;
        }
        return {
          ...current,
          payload: JSON.stringify({
            ...grant,
            refreshHash: hash('refresh', next),
            previousHash: presented,
            rotatedAt: now(),
          }),
        };
      });
      if (outcome === 'retried') return undefined;
      if (!updated) return outcome;
      const grant = parse<Grant>(updated.payload);
      if (!grant) return undefined;
      return { ...(await issueTokens(parts.id, grant)), refresh: next, grant };
    },

    /** The grant an access token belongs to, while both are live. */
    async grantOf(token: string) {
      const parts = split(token);
      if (!parts) return undefined;
      const found = await store.get(partition, hash('access', token));
      const access =
        found?.client === 'access' ? parse<{ grantId: string }>(found.payload) : undefined;
      if (!access || access.grantId !== parts.id) return undefined;
      const grantRow = await store.get(partition, hash('grant', parts.id));
      const grant = grantRow?.client === 'grant' ? parse<Grant>(grantRow.payload) : undefined;
      return grant && grant.expiresAt > now() ? { id: parts.id, grant } : undefined;
    },

    /** Ends the grant of a live access or refresh token issued to this client. */
    async revoke(token: string, clientId: string) {
      const parts = split(token);
      if (!parts) return;
      const key = hash('grant', parts.id);
      const found = await store.get(partition, key);
      const grant = found?.client === 'grant' ? parse<Grant>(found.payload) : undefined;
      if (!grant || grant.clientId !== clientId) return;
      const access = await store.get(partition, hash('access', token));
      const live =
        sameHash(grant.refreshHash, hash('refresh', token)) ||
        (access?.client === 'access' &&
          parse<{ grantId: string }>(access.payload)?.grantId === parts.id);
      if (!live) return;
      await store.delete(partition, key);
      await store.delete(partition, hash('access', token));
    },

    async endFor(principal: Pick<Principal, 'issuer' | 'subject'>) {
      return store.endByLogoutKeys([personKey(principal)]);
    },
  };
};

export type ConnectorGrants = ReturnType<typeof connectorGrants>;
