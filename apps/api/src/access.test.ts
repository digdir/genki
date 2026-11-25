import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { tenantAccess } from './access.js';
import { isOperator, rightsOf } from './rights.js';

const resource = 'urn:altinn:resource:digdir-genai-platform';
const own = '312521172';
const other = '889640782';

const operator: Principal = {
  kind: 'operator',
  issuer: 'https://test.ansattporten.no',
  subject: '26906297387',
  authorizedFor: [{ org: own, resource, actions: ['read'] }],
};

const access = (principal: Principal, tenant: string) =>
  tenantAccess(principal, tenant, new Request('http://localhost/'));

describe('operators in organisations', () => {
  it('an operator with some Altinn rights in an organisation acts there with only those rights', () => {
    const acting = access(operator, own);
    expect(acting?.kind).toBe('employee');
    expect(acting?.tenant).toBe(own);
    expect([...rightsOf(acting as Principal, own)].sort()).toEqual(['use-services', 'view-usage']);
    expect(isOperator(acting as Principal)).toBe(false);
  });

  it('an operator with every platform right in an organisation keeps them there and counts as an operator', () => {
    const member: Principal = { ...operator, authorizedFor: [{ org: own, resource }] };
    const acting = access(member, own);
    expect(acting?.kind).toBe('employee');
    expect(rightsOf(acting as Principal, own).size).toBe(5);
    expect(isOperator(acting as Principal)).toBe(true);
  });

  it('an operator without Altinn rights in an organisation acts there as an operator, not as a member', () => {
    const acting = access(operator, other);
    expect(acting?.kind).toBe('operator');
    expect(acting?.tenant).toBe(other);
    expect(acting?.actor).toEqual(operator);
    expect(acting?.authorizedFor?.some((a) => a.org === other)).toBe(false);
  });
});
