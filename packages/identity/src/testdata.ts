import { z } from 'zod';

const orgno = z.string().regex(/^\d{9}$/);
const pid = z.string().regex(/^\d{11}$/);
const urn = z.string().startsWith('urn:');
const actions = z.array(z.string().min(1));

export const organisation = z.strictObject({
  orgno,
  name: z.string().min(1),
  unitType: z.string().default('ORGL'),
  partyId: z.number().int().optional(),
});

export const party = z.strictObject({
  orgno,
  name: z.string().min(1).optional(),
  unitType: z.string().optional(),
  roles: z.array(z.string().min(1)).default([]),
  accessPackages: z.array(urn).default([]),
  resources: z.record(urn, actions).default({}),
});

export const person = z.strictObject({
  pid,
  name: z.string().min(1),
  description: z.string().optional(),
  userId: z.number().int().optional(),
  parties: z.array(party).default([]),
});

export const tokenEndpointAuthMethod = z.enum([
  'none',
  'client_secret_basic',
  'client_secret_post',
  'private_key_jwt',
]);

export const oidcClient = z
  .strictObject({
    clientId: z.string().min(1),
    redirectUris: z.array(z.url()).min(1),
    audience: z.string().min(1),
    audiences: z.array(z.string().min(1)).default([]),
    tokenEndpointAuthMethod: tokenEndpointAuthMethod.default('none'),
    clientSecret: z.string().min(1).optional(),
    jwks: z.strictObject({ keys: z.array(z.record(z.string(), z.unknown())).min(1) }).optional(),
    postLogoutRedirectUris: z.array(z.url()).default([]),
  })
  .refine(
    (c) => !c.tokenEndpointAuthMethod.startsWith('client_secret') || c.clientSecret !== undefined,
    { message: 'client_secret_* clients need clientSecret' },
  )
  .refine((c) => c.tokenEndpointAuthMethod !== 'private_key_jwt' || c.jwks !== undefined, {
    message: 'private_key_jwt clients need jwks',
  });

export const systemClient = z.strictObject({
  clientId: z.string().min(1),
  consumer: orgno,
  supplier: orgno.optional(),
  scopes: z.array(z.string().min(1)).min(1),
  publicKey: z.record(z.string(), z.unknown()),
  systemUser: z
    .strictObject({
      id: z.string().min(1),
      org: orgno,
      systemId: z.string().min(1),
      resources: z.record(urn, actions).default({}),
    })
    .optional(),
});

export const policyRule = z.strictObject({
  roles: z.array(z.string().min(1)).default([]),
  accessPackages: z.array(urn).default([]),
  actions: actions.min(1),
});

export const resourcePolicy = z
  .union([policyRule, z.strictObject({ rules: z.array(policyRule).min(1) })])
  .transform((p) => ('rules' in p ? p.rules : [p]));

export const identityTestData = z
  .strictObject({
    organisations: z.array(organisation).default([]),
    persons: z.array(person).default([]),
    clients: z.array(oidcClient).default([]),
    systems: z.array(systemClient).default([]),
    resourcePolicies: z.record(urn, resourcePolicy).default({}),
    resourceNames: z.record(urn, z.string().min(1)).default({}),
  })
  .transform((data, ctx) => ({
    ...data,
    persons: data.persons.map((p) => ({
      ...p,
      parties: p.parties.map((party) => {
        const org = data.organisations.find((o) => o.orgno === party.orgno);
        const name = party.name ?? org?.name;
        if (!name)
          ctx.addIssue({
            code: 'custom',
            message: `party ${party.orgno} of ${p.pid} has no name and no organisation entry`,
          });
        return {
          ...party,
          name: name ?? party.orgno,
          unitType: party.unitType ?? org?.unitType ?? 'ORGL',
        };
      }),
    })),
  }));

export type Organisation = z.infer<typeof organisation>;
export type IdentityTestData = z.infer<typeof identityTestData>;
export type IdentityTestDataInput = z.input<typeof identityTestData>;
export type Person = IdentityTestData['persons'][number];
export type Party = Person['parties'][number];
export type OidcClient = z.infer<typeof oidcClient>;
export type SystemClient = z.infer<typeof systemClient>;
export type PolicyRule = z.infer<typeof policyRule>;

const sameCode = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

export const rightsFor = (data: IdentityTestData, party: Party, resource: string): string[] => {
  const viaRules = (data.resourcePolicies[resource] ?? []).flatMap((rule) =>
    rule.roles.some((r) => party.roles.some((own) => sameCode(r, own))) ||
    rule.accessPackages.some((a) => party.accessPackages.includes(a))
      ? rule.actions
      : [],
  );
  return [...new Set([...(party.resources[resource] ?? []), ...viaRules])];
};

export const knownResource = (data: IdentityTestData, resource: string) =>
  resource in data.resourcePolicies ||
  data.persons.some((p) => p.parties.some((party) => resource in party.resources)) ||
  data.systems.some((s) => s.systemUser && resource in s.systemUser.resources);
