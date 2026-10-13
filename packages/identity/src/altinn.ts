import { Hono, type Context } from 'hono';
import { resourceId } from './claims.js';
import { isPlatformRight, platformRightsFromActions } from './platform-rights.js';
import {
  identityTestData,
  knownResource,
  rightsFor,
  type IdentityTestData,
  type IdentityTestDataInput,
} from './testdata.js';

export type AltinnDecision = 'Permit' | 'Deny' | 'NotApplicable' | 'Indeterminate';

export interface AltinnDecisionRequest {
  subject: { personId: string } | { systemUserId: string };
  action: string;
  resource: string;
  party: string;
}

export interface AltinnAuthorization {
  decide(request: AltinnDecisionRequest): Promise<AltinnDecision>;
}

export const XACML = {
  person: 'urn:altinn:person:identifier-no',
  userId: 'urn:altinn:userid',
  systemUser: 'urn:altinn:systemuser:uuid',
  action: 'urn:oasis:names:tc:xacml:1.0:action:action-id',
  resource: 'urn:altinn:resource',
  organization: 'urn:altinn:organization:identifier-no',
  partyId: 'urn:altinn:partyid',
  statusOk: 'urn:oasis:names:tc:xacml:1.0:status:ok',
  statusSyntaxError: 'urn:oasis:names:tc:xacml:1.0:status:syntax-error',
} as const;

const STRING = 'http://www.w3.org/2001/XMLSchema#string';

interface Attribute {
  AttributeId: string;
  Value: string;
  DataType?: string;
}
type Category = { Attribute: Attribute[] }[];
export interface XacmlRequest {
  Request: {
    ReturnPolicyIdList?: boolean;
    AccessSubject: Category;
    Action: Category;
    Resource: Category;
  };
}
export interface XacmlResult {
  Decision: AltinnDecision;
  Status: { StatusCode: { Value: string } };
}
export interface XacmlResponse {
  Response: XacmlResult[];
}

export const toXacml = (request: AltinnDecisionRequest): XacmlRequest => ({
  Request: {
    ReturnPolicyIdList: false,
    AccessSubject: [
      {
        Attribute: [
          'personId' in request.subject
            ? { AttributeId: XACML.person, Value: request.subject.personId }
            : { AttributeId: XACML.systemUser, Value: request.subject.systemUserId },
        ],
      },
    ],
    Action: [
      { Attribute: [{ AttributeId: XACML.action, Value: request.action, DataType: STRING }] },
    ],
    Resource: [
      {
        Attribute: [
          { AttributeId: XACML.resource, Value: resourceId(request.resource) },
          { AttributeId: XACML.organization, Value: request.party },
        ],
      },
    ],
  },
});

const fromXacml = (
  data: IdentityTestData,
  body: Partial<XacmlRequest>,
): AltinnDecisionRequest | undefined => {
  const value = (group: Category | undefined, id: string) =>
    group?.flatMap((g) => g.Attribute ?? []).find((a) => a.AttributeId === id)?.Value;
  const r = body.Request;
  if (!r) return undefined;
  const userId = value(r.AccessSubject, XACML.userId);
  const personId =
    value(r.AccessSubject, XACML.person) ??
    (userId ? (data.persons.find((p) => String(p.userId) === userId)?.pid ?? '') : undefined);
  const systemUserId = value(r.AccessSubject, XACML.systemUser);
  const action = value(r.Action, XACML.action);
  const resource = value(r.Resource, XACML.resource);
  const partyId = value(r.Resource, XACML.partyId);
  const party =
    value(r.Resource, XACML.organization) ??
    (partyId ? data.organisations.find((o) => String(o.partyId) === partyId)?.orgno : undefined);
  if (!action || !resource || !party) return undefined;
  if ((personId === undefined) === (systemUserId === undefined)) return undefined;
  return {
    subject: personId !== undefined ? { personId } : { systemUserId: systemUserId as string },
    action,
    resource: `urn:altinn:resource:${resourceId(resource)}`,
    party,
  };
};

const permits = (granted: string[], action: string) =>
  granted.includes(action) ||
  (isPlatformRight(action) && platformRightsFromActions(granted).includes(action));

export const decideFromTestData = (
  data: IdentityTestData,
  request: AltinnDecisionRequest,
): AltinnDecision => {
  if (!knownResource(data, request.resource)) return 'Indeterminate';
  if ('systemUserId' in request.subject) {
    const id = request.subject.systemUserId;
    const user = data.systems.find((s) => s.systemUser?.id === id)?.systemUser;
    if (!user) return 'Indeterminate';
    if (user.org !== request.party) return 'NotApplicable';
    return permits(user.resources[request.resource] ?? [], request.action)
      ? 'Permit'
      : 'NotApplicable';
  }
  const person = data.persons.find(
    (p) => p.pid === (request.subject as { personId: string }).personId,
  );
  if (!person) return 'Indeterminate';
  const party = person.parties.find((p) => p.orgno === request.party);
  if (!party) return 'NotApplicable';
  return permits(rightsFor(data, party, request.resource), request.action)
    ? 'Permit'
    : 'NotApplicable';
};

const result = (Decision: AltinnDecision, status: string = XACML.statusOk): XacmlResponse => ({
  Response: [{ Decision, Status: { StatusCode: { Value: status } } }],
});

export const createMockAltinnPdp = (testData: IdentityTestDataInput) => {
  const data = identityTestData.parse(testData);
  const app = new Hono();
  const pdp = async (c: Context) => {
    const request = fromXacml(
      data,
      ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<XacmlRequest>,
    );
    if (!request) return c.json(result('Indeterminate', XACML.statusSyntaxError));
    return c.json(result(decideFromTestData(data, request)));
  };
  app.post('/authorization/api/v1/authorize', pdp);
  app.post('/authorization/api/v1/decision', pdp);
  return {
    app,
    authorization: {
      decide: async (r) => decideFromTestData(data, r),
    } satisfies AltinnAuthorization,
  };
};

export interface HttpAltinnOptions {
  baseURL: string;
  headers?: () => Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

export const httpAltinnAuthorization = (options: HttpAltinnOptions): AltinnAuthorization => ({
  decide: async (request) => {
    const response = await (options.fetch ?? fetch)(
      `${options.baseURL}/authorization/api/v1/authorize`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await options.headers?.()) },
        body: JSON.stringify(toXacml(request)),
      },
    );
    if (!response.ok) throw new Error(`Altinn authorization answered ${response.status}`);
    const body = (await response.json()) as Partial<XacmlResponse>;
    return body.Response?.[0]?.Decision ?? 'Indeterminate';
  },
});
