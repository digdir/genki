import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLocalJWKSet } from 'jose';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import {
  createMockAltinnPdp,
  createMockAnsattporten,
  createAuthenticator,
  createSigningKey,
  createTokenVerifier,
  type IdentityTestDataInput,
} from '@genai/identity';
import { tenantAccess } from './access.js';
import { withPdpActions } from './altinn-pdp.js';
import type { Admin } from './admin.js';
import { platformCaller } from './composition.js';
import { operatorDirectory, splitOperators } from './operators.js';
import { refusedAction, requireRight, rightsByOrg, rightsOf, type Right } from './rights.js';

const issuer = 'http://localhost:8080/mock/ansattporten';
const resource = 'urn:altinn:resource:digdir-genai-platform';
const digdir = '991825827';
const fitnessOslo = '897069651';

const localPeople = async () => {
  const raw = parseYaml(
    readFileSync(join(import.meta.dirname, '..', 'config', 'local', 'identity.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  delete raw.devLogin;
  const { testData, operatorPids } = splitOperators(raw);
  const key = await createSigningKey();
  const mock = createMockAnsattporten({
    issuer,
    key,
    testData: testData as IdentityTestDataInput,
  });
  const operators = operatorDirectory({ pids: operatorPids, mockIssuer: issuer });
  const verifier = operators.watch(
    withPdpActions(
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
      createMockAltinnPdp(testData as IdentityTestDataInput),
      resource,
    ),
  );
  const caller = platformCaller(createAuthenticator({ verifier }), {
    isOperator: operators.isOperator,
  });
  return async (pid: string, org?: string) => {
    const { access_token } = await mock.testTokens(pid, 'local-portal', [resource]);
    const found = await caller(
      new Request('http://api/tenants', {
        headers: {
          authorization: `Bearer ${access_token}`,
          ...(org ? { 'genai-acting-for': org } : {}),
        },
      }),
    );
    const principal = found?.principal;
    if (!principal) throw new Error(`no principal for ${pid}`);
    return principal;
  };
};

const sorted = (rights: Set<Right>) => [...rights].sort();

describe('platform rights in the API', () => {
  it('gives the local test persons the rights their Altinn test data grants', async () => {
    const login = await localPeople();

    expect(sorted(rightsOf(await login('01017012345'), digdir))).toEqual([
      'manage-datasets',
      'manage-services',
      'register-building-blocks',
      'use-services',
      'view-usage',
    ]);
    expect(sorted(rightsOf(await login('03037012345', digdir), digdir))).toEqual([
      'manage-datasets',
      'use-services',
      'view-usage',
    ]);
    expect(sorted(rightsOf(await login('04047012345', fitnessOslo), fitnessOslo))).toEqual([
      'use-services',
    ]);
    expect(rightsByOrg(await login('03037012345'), ['405003309', digdir])).toMatchObject({
      '405003309': expect.arrayContaining(['manage-services', 'register-building-blocks']),
      [digdir]: ['use-services', 'manage-datasets', 'view-usage'],
    });
  });

  it('acts for the organisation named in the genai-acting-for header', async () => {
    const login = await localPeople();

    expect((await login('03037012345', digdir)).tenant).toBe(digdir);
    expect((await login('03037012345')).tenant).not.toBe(digdir);
  });

  it("requireRight refuses with the right's Norwegian name", async () => {
    const login = await localPeople();
    const ingrid = await login('03037012345', digdir);

    expect(requireRight(ingrid, digdir, 'manage-datasets')).toEqual({ ok: true });
    expect(requireRight(ingrid, digdir, 'manage-services')).toEqual({
      ok: false,
      problem: {
        type: 'about:blank',
        title: 'Du trenger rettigheten «Administrere tjenester»',
        status: 403,
        errors: [{ path: 'right', message: 'manage-services' }],
      },
    });
    expect(requireRight(ingrid, '889640782', 'use-services')).toMatchObject({
      ok: false,
      problem: { title: 'Du trenger rettigheten «Bruke tjenester»' },
    });
  });

  it('operators keep their access paths', async () => {
    const login = await localPeople();
    const operator = await login('02027012345');
    const admin: Pick<Admin, 'supportSession'> = {
      supportSession: (id) => (id === 'open' ? ({} as never) : undefined),
    };
    const access = tenantAccess(admin);
    const request = (session?: string) =>
      new Request('http://api/tenants', {
        headers: session ? { 'support-session': session } : {},
      });

    expect(operator.kind).toBe('operator');
    expect(access(operator, digdir, request())).toBeUndefined();
    const supporting = access(operator, digdir, request('open'));
    expect(supporting && requireRight(supporting, digdir, 'register-building-blocks')).toEqual({
      ok: true,
    });
    expect(requireRight(operator, digdir, 'manage-datasets')).toEqual({ ok: true });
  });

  it('keeps full access for principals bound to a tenant without Altinn actions', () => {
    const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir };
    expect(requireRight(kari, digdir, 'register-building-blocks')).toEqual({ ok: true });
    expect(requireRight(kari, '889640782', 'use-services').ok).toBe(false);
  });
});

describe('database pipelines that name a tenant secret', () => {
  const datasetAdmin: Principal = {
    kind: 'employee',
    issuer,
    subject: 'ingrid',
    scopes: [],
    authorizedFor: [{ org: digdir, resource, actions: ['manage-datasets'] }],
  };
  const pipeline = (password: string) => ({
    dataset: `${digdir}/arkiv`,
    id: 'kobling',
    spec: {
      source: {
        kind: 'database',
        connection: { engine: 'postgres', host: 'db.example.no', password },
      },
    },
  });

  it("need manage-services unless the secret is the connector's own", () => {
    expect(
      refusedAction(
        datasetAdmin,
        'platform.pipeline.save',
        digdir,
        pipeline(`secret://tenant/${digdir}/arkiv-token`),
      ),
    ).toMatchObject({ kind: 'right', right: 'manage-services' });
    expect(
      refusedAction(
        datasetAdmin,
        'platform.pipeline.save',
        digdir,
        pipeline(`secret://tenant/${digdir}/connector-arkiv`),
      ),
    ).toBeUndefined();
  });
});
