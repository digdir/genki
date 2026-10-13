import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalJWKSet } from 'jose';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  createMockAnsattporten,
  createSigningKey,
  createTokenVerifier,
  type IdentityTestDataInput,
} from '@genai/identity';
import { bearerAuthenticator } from './auth.js';
import { operatorDirectory, splitOperators } from './operators.js';

const issuer = 'http://localhost:8080/mock/ansattporten';
const resource = 'urn:altinn:resource:digdir-genai-platform';
const identityYaml = () => {
  const raw = parseYaml(
    readFileSync(join(import.meta.dirname, '..', 'config', 'local', 'identity.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  delete raw.devLogin;
  return raw;
};

const setup = async () => {
  const { testData, operatorPids } = splitOperators(identityYaml());
  const key = await createSigningKey();
  const mock = createMockAnsattporten({
    issuer,
    key,
    testData: testData as IdentityTestDataInput,
  });
  const operators = operatorDirectory(operatorPids);
  const verifier = operators.watch(
    createTokenVerifier({
      issuers: [
        {
          kind: 'ansattporten',
          issuer,
          audience: 'digdir:genai',
          keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        },
      ],
    }),
  );
  const auth = bearerAuthenticator(verifier, operators.isOperator);
  const principalFor = async (pid: string) => {
    const { access_token } = await mock.testTokens(pid, 'local-console', [resource]);
    return auth.authenticate(
      new Request('http://api/platform', { headers: { authorization: `Bearer ${access_token}` } }),
    );
  };
  return { operatorPids, principalFor };
};

describe('operator mapping', () => {
  it('reads operator flags from the local identity file and strips them from the test data', () => {
    const { testData, operatorPids } = splitOperators(identityYaml());
    expect(operatorPids).toEqual(['02027012345']);
    expect(JSON.stringify(testData)).not.toContain('"operator"');
  });

  it('treats a verified token from a flagged person as an operator principal', async () => {
    const { principalFor } = await setup();
    expect((await principalFor('02027012345'))?.kind).toBe('operator');
  });

  it('keeps everyone else as an employee', async () => {
    const { principalFor } = await setup();
    expect((await principalFor('01017012345'))?.kind).toBe('employee');
  });

  it('still accepts operator subjects added explicitly', () => {
    const operators = operatorDirectory([], ['from-env']);
    operators.add('from-dev-login');
    expect(operators.isOperator({ subject: 'from-env' })).toBe(true);
    expect(operators.isOperator({ subject: 'from-dev-login' })).toBe(true);
    expect(operators.isOperator({ subject: 'someone' })).toBe(false);
  });
});
