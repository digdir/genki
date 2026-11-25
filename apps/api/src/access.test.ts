import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { tenantAccess } from './access.js';
import { rightsOf } from './rights.js';

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
  it('an operator with Altinn rights in an organisation acts there as an employee with those rights', () => {
    const acting = access(operator, own);
    expect(acting?.kind).toBe('employee');
    expect(acting?.tenant).toBe(own);
    expect([...rightsOf(acting as Principal, own)].sort()).toEqual(['use-services', 'view-usage']);
  });

  it('an operator without Altinn rights in an organisation acts there as an operator, not as a member', () => {
    const acting = access(operator, other);
    expect(acting?.kind).toBe('operator');
    expect(acting?.tenant).toBe(other);
    expect(acting?.actor).toEqual(operator);
    expect(acting?.authorizedFor?.some((a) => a.org === other)).toBe(false);
  });

  it('an operator acting as an employee gets no operator rights in that organisation', () => {
    const acting = access(operator, own) as Principal;
    const rights = rightsOf(acting, own);
    expect(rights.has('manage-services')).toBe(false);
    expect(rights.has('manage-datasets')).toBe(false);
    expect(rights.has('register-building-blocks')).toBe(false);
  });
});
