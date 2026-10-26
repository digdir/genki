import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalJWKSet, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import {
  createMockAnsattporten,
  createAuthenticator,
  createSigningKey,
  createTokenVerifier,
  trustedEntraScope,
  type IdentityTestDataInput,
  type SigningKey,
  type TrustedIssuer,
} from '@genai/identity';
import { platformCaller } from './composition.js';
import { operatorDirectory, splitOperators } from './operators.js';

const issuer = 'http://localhost:8080/mock/ansattporten';
const realIssuer = 'https://test.ansattporten.example';
const maskinporten = 'https://test.maskinporten.example/';
const resource = 'urn:altinn:resource:digdir-genai-platform';
const flaggedPid = '02027012345';
const consoleClient = 'genki-test-console';
const trustedGroup = '0f0e0d0c-0b0a-4908-8706-050403020100';
const identityYaml = () => {
  const raw = parseYaml(
    readFileSync(join(import.meta.dirname, '..', 'config', 'local', 'identity.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  delete raw.devLogin;
  return raw;
};

let key: SigningKey;
beforeAll(async () => {
  key = await createSigningKey('operators');
});

const sign = (iss: string, claims: Record<string, unknown>, subject?: string) => {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(iss)
    .setAudience('digdir:genai')
    .setIssuedAt()
    .setExpirationTime('5m');
  return (subject ? jwt.setSubject(subject) : jwt).sign(key.privateKey);
};

const callerWith = (issuers: TrustedIssuer[], operators: ReturnType<typeof operatorDirectory>) => {
  const verifier = operators.watch(createTokenVerifier({ issuers }));
  const caller = platformCaller(createAuthenticator({ verifier }), {
    isOperator: operators.isOperator,
  });
  return async (token: string) =>
    (
      await caller(
        new Request('http://api/platform', { headers: { authorization: `Bearer ${token}` } }),
      )
    )?.principal;
};

const ansattporten = (iss: string, extra: Partial<TrustedIssuer> = {}): TrustedIssuer =>
  ({
    kind: 'ansattporten',
    issuer: iss,
    audience: 'digdir:genai',
    keys: createLocalJWKSet({ keys: [key.publicJwk] }),
    ...extra,
  }) as TrustedIssuer;

const setup = async () => {
  const { testData, operatorPids } = splitOperators(identityYaml());
  const mockKey = await createSigningKey();
  const mock = createMockAnsattporten({
    issuer,
    key: mockKey,
    testData: testData as IdentityTestDataInput,
  });
  const operators = operatorDirectory({ pids: operatorPids, mockIssuer: issuer });
  const verifier = operators.watch(
    createTokenVerifier({
      issuers: [
        {
          kind: 'ansattporten',
          issuer,
          audience: 'digdir:genai',
          keys: createLocalJWKSet({ keys: [mockKey.publicJwk] }),
        },
      ],
    }),
  );
  const caller = platformCaller(createAuthenticator({ verifier }), {
    isOperator: operators.isOperator,
  });
  const principalFor = async (pid: string) => {
    const { access_token } = await mock.testTokens(pid, 'local-console', [resource]);
    const found = await caller(
      new Request('http://api/platform', { headers: { authorization: `Bearer ${access_token}` } }),
    );
    return found?.principal;
  };
  return { operatorPids, principalFor };
};

describe('operator mapping', () => {
  it('reads operator flags from the local identity file and strips them from the test data', () => {
    const { testData, operatorPids } = splitOperators(identityYaml());
    expect(operatorPids).toEqual([flaggedPid]);
    expect(JSON.stringify(testData)).not.toContain('"operator"');
  });

  it('treats a verified token from a flagged person as an operator principal', async () => {
    const { principalFor } = await setup();
    expect((await principalFor(flaggedPid))?.kind).toBe('operator');
  });

  it('keeps everyone else as an employee', async () => {
    const { principalFor } = await setup();
    expect((await principalFor('01017012345'))?.kind).toBe('employee');
  });

  it('matches an operator subject only together with its issuer', () => {
    const operators = operatorDirectory({
      subjects: [`${realIssuer}|kari`],
      clientIds: ['genki-console'],
    });
    const person = {
      kind: 'employee' as const,
      issuer: realIssuer,
      subject: 'kari',
      client: 'genki-console',
    };

    expect(operators.isOperator(person)).toBe(true);
    expect(operators.isOperator({ ...person, issuer: 'https://other.example' })).toBe(false);
    expect(operators.isOperator({ ...person, subject: 'ola' })).toBe(false);
  });

  it('counts a listed operator subject only for logins through an operator client', () => {
    const operators = operatorDirectory({
      subjects: [`${realIssuer}|kari`],
      clientIds: ['genki-console'],
    });
    const person = { kind: 'employee' as const, issuer: realIssuer, subject: 'kari' };

    expect(operators.isOperator({ ...person, client: 'genki-console' })).toBe(true);
    expect(operators.isOperator({ ...person, client: 'someone-elses-app' })).toBe(false);
    expect(operators.isOperator(person)).toBe(false);
    expect(
      operatorDirectory({ subjects: [`${realIssuer}|kari`] }).isOperator({
        ...person,
        client: 'genki-console',
      }),
    ).toBe(false);
  });

  it('accepts a bare operator subject only for the mock login', () => {
    const person = { kind: 'employee' as const, issuer: realIssuer, subject: 'from-env' };

    expect(operatorDirectory({ subjects: ['from-env'] }).isOperator(person)).toBe(false);
    const local = operatorDirectory({ subjects: ['from-env'], mockIssuer: issuer });
    expect(local.isOperator(person)).toBe(false);
    expect(local.isOperator({ ...person, issuer })).toBe(true);
  });

  it('marks a dev login as operator only when it comes from the mock login', () => {
    const operators = operatorDirectory({ mockIssuer: issuer });
    operators.add({ issuer, subject: 'from-dev-login' });
    operators.add({ issuer: realIssuer, subject: 'elsewhere' });

    expect(operators.isOperator({ kind: 'employee', issuer, subject: 'from-dev-login' })).toBe(
      true,
    );
    expect(
      operators.isOperator({ kind: 'employee', issuer: realIssuer, subject: 'elsewhere' }),
    ).toBe(false);
  });

  it('a Maskinporten client whose id is in OPERATOR_SUBJECTS is not an operator', async () => {
    const operators = operatorDirectory({
      subjects: [`${maskinporten}|mp-client`, 'mp-client', `${maskinporten}|system-user-1`],
      mockIssuer: issuer,
    });
    const principalOf = callerWith(
      [
        {
          kind: 'maskinporten',
          issuer: maskinporten,
          audience: 'digdir:genai',
          keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        },
      ],
      operators,
    );
    const consumer = { authority: 'iso6523-actorid-upis', ID: '0192:991825827' };
    const client = await sign(maskinporten, { client_id: 'mp-client', consumer, scope: '' });
    const systemUser = await sign(maskinporten, {
      client_id: 'vendor-client',
      consumer,
      scope: '',
      authorization_details: [
        {
          type: 'urn:altinn:systemuser',
          systemuser_org: consumer,
          systemuser_id: ['system-user-1'],
        },
      ],
    });

    expect((await principalOf(client))?.kind).toBe('agency-system');
    expect((await principalOf(systemUser))?.kind).toBe('vendor-system');
  });

  it('an identity.yaml operator pid makes no one an operator outside the dev-mode mock', async () => {
    const { operatorPids } = splitOperators(identityYaml());
    const token = await sign(realIssuer, { acr: 'idporten-loa-substantial', pid: flaggedPid }, 's');
    const outsideDevMode = callerWith(
      [ansattporten(realIssuer)],
      operatorDirectory({ pids: operatorPids }),
    );
    const otherIssuerInDevMode = callerWith(
      [ansattporten(realIssuer)],
      operatorDirectory({ pids: operatorPids, mockIssuer: issuer }),
    );

    expect((await outsideDevMode(token))?.kind).toBe('employee');
    expect((await otherIssuerInDevMode(token))?.kind).toBe('employee');
  });

  it('the allowlisted console client still gets the operator mark in lockdown', async () => {
    const principalOf = callerWith(
      [
        ansattporten(realIssuer, {
          trustedEntra: {
            groups: [trustedGroup],
            clientIds: [consoleClient],
            tenant: '991825827',
            resource,
          },
        }),
      ],
      operatorDirectory({}),
    );
    const token = await sign(
      realIssuer,
      { acr: 'entraid', client_id: consoleClient, groups: [trustedGroup] },
      'entra-subject',
    );

    expect(await principalOf(token)).toMatchObject({
      kind: 'operator',
      scopes: [trustedEntraScope],
    });
  });

  it('never marks a principal confined to a registered client as operator', () => {
    const operators = operatorDirectory({ subjects: [`${realIssuer}|kari`] });
    const confinedTo = { tenant: '991825827', service: 'klarsprak', client: 'tenant-app' };
    const entra: Principal = {
      kind: 'employee',
      issuer: realIssuer,
      subject: 'entra-subject',
      scopes: [trustedEntraScope],
    };

    expect(operators.isOperator(entra)).toBe(true);
    expect(operators.isOperator({ ...entra, confinedTo })).toBe(false);
    expect(
      operators.isOperator({ kind: 'employee', issuer: realIssuer, subject: 'kari', confinedTo }),
    ).toBe(false);
  });
});
