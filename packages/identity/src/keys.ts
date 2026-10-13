import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export const createSigningKey = async (kid: string = randomUUID()): Promise<SigningKey> => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' },
  };
};
