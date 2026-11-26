import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@genai/contracts';

const acting = new AsyncLocalStorage<{ principal: Principal; nonce: string }>();
export const connectorHeader = 'genki-design-connector';

const sameNonce = (given: string | null, nonce: string) =>
  given !== null &&
  given.length === nonce.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(nonce));

/** The person a design connector grant calls the API for, only on requests the connector made. */
export const connectorCaller = (request?: Request) => {
  const store = acting.getStore();
  if (!store) return undefined;
  return request === undefined || sameNonce(request.headers.get(connectorHeader), store.nonce)
    ? { principal: store.principal }
    : undefined;
};

export const actAsConnector = <T>(principal: Principal, work: (nonce: string) => T): T => {
  const nonce = randomBytes(24).toString('base64url');
  return acting.run({ principal, nonce }, () => work(nonce));
};
