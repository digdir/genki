import { createLocalJWKSet, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  altinnActionLookup,
  cachedActionLookup,
  createSigningKey,
  createTokenVerifier,
  platformRightsOf,
  withAltinnActions,
  type AltinnAuthorization,
  type AltinnDecisionRequest,
  type SigningKey,
} from './index.js';

const ISSUER = 'https://test.ansattporten.no';
const AUDIENCE = 'digdir:genai';
const RESOURCE = 'urn:altinn:resource:digdir-genai-platform-test';
const ORG = '312521172';
const PID = '26906297387';

const realDetails = [
  {
    type: 'ansattporten:altinn:resource',
    resource: 'urn:altinn:resource:digdir-genai-platform-test',
    resource_name: 'GenKI, fellesløsning for generativ KI (test)',
    authorized_parties: [
      {
        orgno: { authority: 'iso6523-actorid-upis', ID: '0192:312521172' },
        resource: 'digdir-genai-platform-test',
        name: 'FALSK IDIOTSIKKER ELEFANT',
        unit_type: 'STAT',
      },
    ],
  },
];

let key: SigningKey;

beforeAll(async () => {
  key = await createSigningKey('test-1');
});

const tokenWith = (details: unknown) =>
  new SignJWT({ acr: 'idporten-loa-substantial', pid: PID, authorization_details: details })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);

const verifier = () =>
  createTokenVerifier({
    issuers: [
      {
        kind: 'ansattporten',
        issuer: ISSUER,
        audience: AUDIENCE,
        keys: createLocalJWKSet({ keys: [key.publicJwk] }),
      },
    ],
  });

const dagl = () => {
  const asked: AltinnDecisionRequest[] = [];
  const altinn: AltinnAuthorization = {
    decide: async (request) => {
      asked.push(request);
      return request.action === 'read' || request.action === 'write' ? 'Permit' : 'NotApplicable';
    },
  };
  return { asked, altinn };
};

describe('platform rights from the Altinn decision point', () => {
  it('asks the Altinn decision point for actions when the token lists the party without actions', async () => {
    const { asked, altinn } = dagl();
    const { principal } = await withAltinnActions(verifier(), {
      lookup: altinnActionLookup(altinn),
      resource: RESOURCE,
    }).verify(await tokenWith(realDetails));
    expect(asked).toContainEqual({
      subject: { personId: PID },
      action: 'write',
      resource: RESOURCE,
      party: ORG,
    });
    expect(principal.authorizedFor).toEqual([
      { org: ORG, resource: RESOURCE, actions: ['read', 'write'] },
    ]);
    expect(platformRightsOf(principal, ORG, RESOURCE)).toContain('manage-services');
  });

  it('keeps the actions the token carries', async () => {
    const { asked, altinn } = dagl();
    const details = [
      {
        ...realDetails[0],
        authorized_parties: [{ ...realDetails[0]?.authorized_parties[0], actions: ['read'] }],
      },
    ];
    const { principal } = await withAltinnActions(verifier(), {
      lookup: altinnActionLookup(altinn),
      resource: RESOURCE,
    }).verify(await tokenWith(details));
    expect(asked).toEqual([]);
    expect(principal.authorizedFor?.[0]?.actions).toEqual(['read']);
  });

  it('gives no rights when the decision point fails', async () => {
    const errors: unknown[] = [];
    const { principal } = await withAltinnActions(verifier(), {
      lookup: altinnActionLookup({
        decide: async () => {
          throw new Error('Altinn authorization answered 503');
        },
      }),
      resource: RESOURCE,
      onError: (error) => errors.push(error),
    }).verify(await tokenWith(realDetails));
    expect(principal.authorizedFor?.[0]?.actions).toEqual([]);
    expect(platformRightsOf(principal, ORG, RESOURCE)).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('gives no rights for a party listed without actions when nobody asks the decision point', async () => {
    const { principal } = await verifier().verify(await tokenWith(realDetails));
    expect(platformRightsOf(principal, ORG, RESOURCE)).toEqual([]);
  });

  it('asks once per person, party and resource within the cache lifetime', async () => {
    const { asked, altinn } = dagl();
    let now = 0;
    const lookup = cachedActionLookup(altinnActionLookup(altinn, ['read', 'write']), {
      now: () => now,
    });
    const verify = withAltinnActions(verifier(), { lookup, resource: RESOURCE });
    const token = await tokenWith(realDetails);
    await Promise.all([verify.verify(token), verify.verify(token)]);
    await verify.verify(token);
    expect(asked).toHaveLength(2);
    now = 121_000;
    await verify.verify(token);
    expect(asked).toHaveLength(4);
  });

  it('asks again after the decision point failed', async () => {
    let calls = 0;
    const lookup = cachedActionLookup(async () => {
      calls += 1;
      if (calls === 1) throw new Error('timeout');
      return ['read'];
    });
    await expect(lookup(PID, ORG, RESOURCE)).rejects.toThrow('timeout');
    await expect(lookup(PID, ORG, RESOURCE)).resolves.toEqual(['read']);
  });
});
