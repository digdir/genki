import type { Principal } from '@genai/contracts';
import { describe, expect, it } from 'vitest';
import { supportSessionHeader, tenantAccess } from './access.js';
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

const access = (sessionFor?: string) =>
  tenantAccess({
    supportSession: (id, _operator, tenant) =>
      id === 'session-1' && tenant === sessionFor ? ({ id } as never) : undefined,
  });

const request = (session?: string) =>
  new Request('http://localhost/', {
    headers: session ? { [supportSessionHeader]: session } : {},
  });

describe('operators in organisations', () => {
  it('an operator with Altinn rights in an organisation acts there as an employee with those rights', () => {
    const acting = access()(operator, own, request());
    expect(acting?.kind).toBe('employee');
    expect(acting?.tenant).toBe(own);
    expect([...rightsOf(acting as Principal, own)].sort()).toEqual(['use-services', 'view-usage']);
  });

  it('an operator without Altinn rights in an organisation still needs a support session', () => {
    expect(access()(operator, other, request())).toBeUndefined();
    const acting = access(other)(operator, other, request('session-1'));
    expect(acting?.kind).toBe('operator');
    expect(acting?.actor).toEqual(operator);
  });

  it('an operator acting as an employee gets no operator rights in that organisation', () => {
    const acting = access()(operator, own, request()) as Principal;
    const rights = rightsOf(acting, own);
    expect(rights.has('manage-services')).toBe(false);
    expect(rights.has('manage-datasets')).toBe(false);
    expect(rights.has('register-building-blocks')).toBe(false);
  });
});
